# DesiVideoHub

Full-stack responsive video site: Next.js 15 + React 19 + Tailwind CSS 4, Express, Prisma 6, PostgreSQL, local disk, FFmpeg. Dark pink theme. Public playback; signed-in downloads. Admin upload/management, 20 categories, search, sorting, pagination, analytics.

## Requirements
- Node.js 22 LTS or newer and npm
- PostgreSQL 16+ installed locally **or** Docker Desktop (for included PostgreSQL service)
- `ffmpeg` and `ffprobe` installed and on your PATH (`ffmpeg -version` / `ffprobe -version`)
- At least 8 GB RAM, enough free disk for originals + temporary uploads + transcoded output

## Quick start (Windows PowerShell)
1. Extract the ZIP. Open PowerShell in the extracted `desivideohub` folder.
2. `Copy-Item .env.example .env` and edit `.env`: use your actual PostgreSQL password, a random `JWT_SECRET` of 32+ characters, and your own strong `ADMIN_PASSWORD` (12+ characters). Never commit `.env`.
3. If you don't already have PostgreSQL, start Docker Desktop then `docker compose up -d db`. **Do not** start the Docker database if local PostgreSQL is already listening on port 5432. If using your own PostgreSQL, create database `desivideohub` (e.g. via pgAdmin) and set DATABASE_URL.
4. `npm install`
5. `npm run db:migrate` (first run: Prisma prompts for a migration name, enter `init`)
6. `npm run db:seed` (creates 20 categories and your admin account)
7. `npm run dev`
8. Open `http://localhost:3000`. Admin: `http://localhost:3000/admin`, login with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.

**Mac/Linux:** use `cp .env.example .env` instead of `Copy-Item`.

## Important: env loading
The backend uses dotenv and expects `.env` in its **working directory** (`backend/`). The Next.js frontend expects its public API URL in `frontend/.env.local`. After editing the root `.env`, copy the same file into `backend/.env` and create `frontend/.env.local` containing `NEXT_PUBLIC_API_URL=http://localhost:5000`. Example PowerShell:

```powershell
Copy-Item .env backend/.env
Set-Content frontend/.env.local 'NEXT_PUBLIC_API_URL=http://localhost:5000'
```

Run the two commands **before** migration/seed/start. If you change root `.env`, copy it to backend again.

## Commands
- `npm run dev`: frontend and backend in development
- `npm run build`: production build (generate Prisma client + Next build)
- `npm run db:migrate`: create/apply Prisma development migrations
- `npm run db:seed`: create categories and admin account
- `npm run start -w backend` and `npm run start -w frontend`: run production servers after build (in separate terminals)

## Features
- Homepage search and category filters; latest, most viewed, longest, popular (downloads then views), and random; paginated results.
- HTML5 MP4 streaming with HTTP byte-range support; public video watch pages and related videos.
- Secure login/signup via Argon2 password hashes and signed JWT in HTTP-only SameSite cookies. Download endpoint checks login.
- Admin dashboard: total users, views, downloads, video counts; upload with FFmpeg MP4 transcode and thumbnail; edit title, publish/hide, delete; create/delete categories; view users and change roles.
- Files: `backend/storage/videos`, `backend/storage/thumbnails`, `backend/storage/tmp`. These folders are gitignored. PostgreSQL stores metadata, not large videos.

## Notes and limitations
- This is a runnable local-development MVP, not a production-hardened video platform. Use HTTPS, a reverse proxy, CSRF protection, a background job queue for transcoding, better upload validation (ffprobe actual codec), virus scanning, resumable uploads, object storage/CDN, monitoring, database backups, robust download tracking, and content moderation before public deployment.
- Upload requests transcode synchronously. Large videos can take minutes and consume significant CPU/disk. A reverse proxy may need a higher request timeout.
- File uploads are capped at 1 GB; the server temporarily stores input and creates a separate MP4. Keep enough disk free.
- Random sorting is reshuffled per request; page navigation may repeat videos. For stable random pagination, implement a seeded shuffle.
- Downloads are counted when initiated, not when fully transferred.
- Admin seeded password changes in `.env` **do not** reset an existing admin password; seed only promotes existing admin role.
- Default cookie settings assume frontend/backend on the same hostname (`localhost`) with different ports. Cross-domain deployment needs appropriate cookie/CSRF/CORS configuration.
- If mobile devices use the site over LAN, `localhost` refers to **their own** device, so set `NEXT_PUBLIC_API_URL` to the computer's reachable LAN address and update FRONTEND_URL. HTTPS is recommended for non-local use.
- Use only videos you have the right to distribute. Add legal/privacy/terms pages appropriate to your deployment.
