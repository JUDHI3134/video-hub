import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express(),
  db = new PrismaClient();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../storage",
);
const originals = path.join(root, "videos"),
  thumbs = path.join(root, "thumbnails"),
  temp = path.join(root, "tmp");
await Promise.all(
  [originals, thumbs, temp].map((d) => fs.mkdir(d, { recursive: true })),
);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw Error("JWT_SECRET must be at least 32 characters");
const secret = process.env.JWT_SECRET;
const frontend = process.env.FRONTEND_URL || "http://localhost:3000";
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: frontend, credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
// Reject cross-origin state-changing browser requests (cookie-based CSRF defense).
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== frontend)
      return res.status(403).json({ error: "Untrusted origin" });
  }
  next();
});
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const sign = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: "7d" });
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
});
const auth = asyncRoute(async (req, res, next) => {
  let token = req.cookies.session;
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    const payload = jwt.verify(token, secret);
    const user = await db.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: "Account unavailable" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid session" });
  }
});
const admin = (req, res, next) =>
  req.user?.role === "ADMIN"
    ? next()
    : res.status(403).json({ error: "Admin only" });
const credentials = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});
app.post(
  "/api/auth/signup",
  authLimit,
  asyncRoute(async (req, res) => {
    const v = credentials
      .extend({ name: z.string().trim().min(2).max(80) })
      .parse(req.body);
    const email = v.email.toLowerCase();
    if (await db.user.findUnique({ where: { email } }))
      return res.status(409).json({ error: "Email already registered" });
    const user = await db.user.create({
      data: {
        email,
        name: v.name,
        passwordHash: await argon2.hash(v.password),
      },
    });
    res
      .cookie("session", sign(user), cookieOptions)
      .status(201)
      .json({ user: publicUser(user) });
  }),
);
app.post(
  "/api/auth/login",
  authLimit,
  asyncRoute(async (req, res) => {
    const v = credentials.parse(req.body),
      user = await db.user.findUnique({
        where: { email: v.email.toLowerCase() },
      });
    if (!user || !(await argon2.verify(user.passwordHash, v.password)))
      return res.status(401).json({ error: "Incorrect email or password" });
    res
      .cookie("session", sign(user), cookieOptions)
      .json({ user: publicUser(user) });
  }),
);
app.post("/api/auth/logout", (_req, res) =>
  res
    .clearCookie("session", {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    })
    .json({ ok: true }),
);
app.get("/api/auth/me", auth, (req, res) =>
  res.json({ user: publicUser(req.user) }),
);
app.get(
  "/api/categories",
  asyncRoute(async (_req, res) =>
    res.json(
      await db.category.findMany({
        orderBy: { name: "asc" },
        include: { _count: { select: { videos: true } } },
      }),
    ),
  ),
);
const videoFields = {
  id: true,
  title: true,
  description: true,
  thumbnail: true,
  duration: true,
  views: true,
  downloadsCount: true,
  createdAt: true,
  status: true,
  category: true,
  _count: {
    select: {
      likes: true,
    }
  }
};
const serialize = (v) => ({ ...v, size: v.size?.toString() });
app.get(
  "/api/videos",
  asyncRoute(async (req, res) => {
    const page = Math.max(
        1,
        Math.min(100000, Number.parseInt(req.query.page) || 1),
      ),
      limit = Math.max(1, Math.min(48, Number.parseInt(req.query.limit) || 12));
    const sort = String(req.query.sort || "latest");
    const where = { status: "PUBLISHED" };
    if (req.query.category)
      where.category = { slug: String(req.query.category) };
    if (req.query.search)
      where.OR = [
        {
          title: {
            contains: String(req.query.search).slice(0, 100),
            mode: "insensitive",
          },
        },
        {
          description: {
            contains: String(req.query.search).slice(0, 100),
            mode: "insensitive",
          },
        },
      ];
    const orders = {
      latest: { createdAt: "desc" },
      views: { views: "desc" },
      longest: { duration: "desc" },
      popular: [{ downloadsCount: "desc" }, { views: "desc" }],
    };
    const total = await db.video.count({ where });
    let videos;
    if (sort === "random") {
      const ids = await db.video.findMany({ where, select: { id: true } });
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      const selected = ids
        .slice((page - 1) * limit, page * limit)
        .map((x) => x.id);
      const found = await db.video.findMany({
        where: { id: { in: selected } },
        select: videoFields,
      });
      videos = selected
        .map((id) => found.find((v) => v.id === id))
        .filter(Boolean);
    } else {
      videos = await db.video.findMany({
        where,
        orderBy: orders[sort] || orders.latest,
        skip: (page - 1) * limit,
        take: limit,
        select: videoFields,
      });
    }
    res.json({ videos, total, page, pages: Math.ceil(total / limit), limit });
  }),
);
app.get(
  "/api/videos/:id",
  asyncRoute(async (req, res) => {
    const v = await db.video.findFirst({
      where: { id: req.params.id, status: "PUBLISHED" },
      select: videoFields,
    });
    if (!v) return res.status(404).json({ error: "Video not found" });
    res.json(v);
  }),
);

const getVideo = async (id) => db.video.findUnique({ where: { id } });

app.get('/api/videos/:id/like', auth, asyncRoute(async (req, res) => {
  const video = await db.video.findFirst({
    where: { id: req.params.id, status: 'PUBLISHED' },
    select: { id: true }
  });

  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const [like, count] = await Promise.all([
    db.videoLike.findUnique({
      where: {
        userId_videoId: {
          userId: req.user.id,
          videoId: video.id
        }
      }
    }),
    db.videoLike.count({ where: { videoId: video.id } })
  ]);

  res.json({ liked: Boolean(like), likesCount: count });
}));

app.post('/api/videos/:id/like', auth, asyncRoute(async (req, res) => {
  const video = await db.video.findFirst({
    where: { id: req.params.id, status: 'PUBLISHED' },
    select: { id: true }
  });

  if (!video) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const key = {
    userId: req.user.id,
    videoId: video.id
  };

  // A database transaction keeps the toggle and count consistent.
  const result = await db.$transaction(async (tx) => {
    // Lock the user's row to serialize their like requests.
    await tx.$queryRaw`
      SELECT id FROM "User"
      WHERE id = ${req.user.id}
      FOR UPDATE
    `;

    const existing = await tx.videoLike.findUnique({
      where: { userId_videoId: key }
    });

    let liked;

    if (existing) {
      await tx.videoLike.delete({
        where: { userId_videoId: key }
      });
      liked = false;
    } else {
      await tx.videoLike.create({ data: key });
      liked = true;
    }

    const likesCount = await tx.videoLike.count({
      where: { videoId: video.id }
    });

    return { liked, likesCount };
  });

  res.json(result);
}));

const safeFile = (base, name) => path.join(base, path.basename(name));
app.get(
  "/api/videos/:id/stream",
  asyncRoute(async (req, res) => {
    const v = await getVideo(req.params.id);
    if (!v || v.status !== "PUBLISHED") return res.status(404).end();
    const file = safeFile(originals, v.filename);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return res.status(404).end();
    }
    const size = stat.size,
      range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", v.mimeType);
    res.setHeader("Cache-Control", "private, no-store");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match)
        return res.status(416).set("Content-Range", `bytes */${size}`).end();
      let start = match[1] ? Number(match[1]) : 0,
        end = match[2] ? Number(match[2]) : size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return res.status(416).set("Content-Range", `bytes */${size}`).end();
      end = Math.min(end, size - 1);
      res
        .status(206)
        .set({
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": end - start + 1,
        });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.set("Content-Length", size);
      createReadStream(file).pipe(res);
    }
  }),
);
app.post(
  "/api/videos/:id/view",
  rateLimit({ windowMs: 60 * 1000, limit: 120 }),
  asyncRoute(async (req, res) => {
    const v = await db.video.updateMany({
      where: { id: req.params.id, status: "PUBLISHED" },
      data: { views: { increment: 1 } },
    });
    res.json({ ok: v.count > 0 });
  }),
);
app.get(
  "/api/videos/:id/thumbnail",
  asyncRoute(async (req, res) => {
    const v = await getVideo(req.params.id);
    if (!v || v.status !== "PUBLISHED" || !v.thumbnail)
      return res.status(404).end();
    res.type("image/jpeg").sendFile(safeFile(thumbs, v.thumbnail));
  }),
);
app.get(
  "/api/videos/:id/download",
  auth,
  asyncRoute(async (req, res) => {
    const v = await getVideo(req.params.id);
    if (!v || v.status !== "PUBLISHED")
      return res.status(404).json({ error: "Video not found" });
    const file = safeFile(originals, v.filename);
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: "File missing" });
    }
    await db.$transaction([
      db.download.create({ data: { userId: req.user.id, videoId: v.id } }),
      db.video.update({
        where: { id: v.id },
        data: { downloadsCount: { increment: 1 } },
      }),
    ]);
    res.download(
      file,
      `${v.title.replace(/[^a-z0-9 _-]/gi, "").slice(0, 80) || "video"}.mp4`,
    );
  }),
);
const upload = multer({
  dest: temp,
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    cb(
      null,
      ["video/mp4", "video/webm", "video/quicktime"].includes(file.mimetype),
    ),
});
const run = (bin, args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let err = "";
    proc.stderr.on("data", (x) => (err += x.toString().slice(-1000)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve(err)
        : reject(Error(`${bin} exited ${code}: ${err.slice(-300)}`)),
    );
  });
const probe = async (file) => {
  let out = "";
  await new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    proc.stdout.on("data", (d) => (out += d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(Error("ffprobe failed")),
    );
  });
  return Math.max(0, Math.round(Number(out.trim()) || 0));
};
app.post(
  "/api/admin/videos",
  auth,
  admin,
  upload.single("video"),
  asyncRoute(async (req, res) => {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "MP4, WebM or MOV video required (max 1 GB)" });
    const incoming = req.file.path;
    let output;
    try {
      const {
        title,
        description = "",
        categoryId,
      } = z
        .object({
          title: z.string().trim().min(2).max(180),
          description: z.string().max(3000).optional(),
          categoryId: z.string().min(1),
        })
        .parse(req.body);
      if (!(await db.category.findUnique({ where: { id: categoryId } })))
        return res.status(400).json({ error: "Unknown category" });
      const filename = randomUUID() + ".mp4",
        thumbnail = randomUUID() + ".jpg";
      output = safeFile(originals, filename);
      await run("ffmpeg", [
        "-y",
        "-i",
        incoming,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output,
      ]);
      const duration = await probe(output);
      const thumb = safeFile(thumbs, thumbnail);
      try {
        await run("ffmpeg", [
          "-y",
          "-ss",
          String(Math.min(2, Math.max(0, duration / 2))),
          "-i",
          output,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:-2",
          thumb,
        ]);
      } catch {
        /* no thumbnail */
      }
      const hasThumb = await fs
        .access(thumb)
        .then(() => true)
        .catch(() => false);
      const stat = await fs.stat(output);
      const video = await db.video.create({
        data: {
          title,
          description,
          categoryId,
          filename,
          thumbnail: hasThumb ? thumbnail : null,
          duration,
          size: BigInt(stat.size),
          mimeType: "video/mp4",
          status: "PUBLISHED",
        },
      });
      res.status(201).json({ video: serialize(video) });
    } finally {
      await fs.rm(incoming, { force: true }).catch(() => {});
    }
  }),
);
app.get(
  "/api/admin/stats",
  auth,
  admin,
  asyncRoute(async (_req, res) => {
    const [videos, users, views, downloads] = await Promise.all([
      db.video.count(),
      db.user.count(),
      db.video.aggregate({ _sum: { views: true } }),
      db.download.count(),
    ]);
    res.json({ videos, users, views: views._sum.views || 0, downloads });
  }),
);
app.get(
  "/api/admin/videos",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page) || 1),
      take = 20;
    const [videos, total] = await Promise.all([
      db.video.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * take,
        take,
        include: { category: true },
      }),
      db.video.count(),
    ]);
    res.json({
      videos: videos.map(serialize),
      total,
      pages: Math.ceil(total / take),
    });
  }),
);
app.patch(
  "/api/admin/videos/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        title: z.string().trim().min(2).max(180).optional(),
        description: z.string().max(3000).optional(),
        categoryId: z.string().optional(),
        status: z.enum(["PUBLISHED", "PROCESSING", "FAILED"]).optional(),
      })
      .strict()
      .parse(req.body);
    res.json(
      serialize(await db.video.update({ where: { id: req.params.id }, data })),
    );
  }),
);
app.delete(
  "/api/admin/videos/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const v = await getVideo(req.params.id);
    if (!v) return res.status(404).json({ error: "Not found" });
    await db.video.delete({ where: { id: v.id } });
    await Promise.all([
      fs.rm(safeFile(originals, v.filename), { force: true }),
      v.thumbnail
        ? fs.rm(safeFile(thumbs, v.thumbnail), { force: true })
        : Promise.resolve(),
    ]);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/admin/categories",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const { name } = z
      .object({ name: z.string().trim().min(2).max(50) })
      .parse(req.body);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug)
      return res
        .status(400)
        .json({ error: "Use a name with Latin characters" });
    res.status(201).json(await db.category.create({ data: { name, slug } }));
  }),
);
app.delete(
  "/api/admin/categories/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const count = await db.video.count({
      where: { categoryId: req.params.id },
    });
    if (count)
      return res.status(409).json({ error: "Category contains videos" });
    await db.category.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/admin/users",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page) || 1);
    const users = await db.user.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 25,
      take: 25,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
    res.json(users);
  }),
);
app.patch(
  "/api/admin/users/:id",
  auth,
  admin,
  asyncRoute(async (req, res) => {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: "Cannot change your own role" });
    const { role } = z
      .object({ role: z.enum(["USER", "ADMIN"]) })
      .parse(req.body);
    const u = await db.user.update({
      where: { id: req.params.id },
      data: { role },
    });
    res.json(publicUser(u));
  }),
);
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof z.ZodError)
    return res
      .status(400)
      .json({ error: err.issues.map((i) => i.message).join(", ") });
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: err.message });
  if (err.code === "P2002")
    return res.status(409).json({ error: "Already exists" });
  res.status(500).json({ error: "Server error" });
});
app.listen(Number(process.env.PORT) || 5000, () =>
  console.log(
    "API listening on http://localhost:" + (process.env.PORT || 5000),
  ),
);
