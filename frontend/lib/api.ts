export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
export type Category = {
  id: string;
  name: string;
  slug: string;
  _count?: { videos: number };
};
export type Video = {
  id: string;
  title: string;
  description: string;
  duration: number;
  views: number;
  downloadsCount: number;
  createdAt: string;
  thumbnail: string | null;
  status: string;
  category: Category;
  count?: {
    likes: number;
  };
};
export type User = {
  id: string;
  name: string;
  email: string;
  role: "USER" | "ADMIN";
};
export async function api<T = any>(
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(API + route, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({ error: "Network error" }));
  if (!res.ok) throw Error(data.error || "Request failed");
  return data as T;
}
export function time(n: number) {
  return `${Math.floor(n / 3600) ? Math.floor(n / 3600) + ":" : ""}${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
export function short(n: number) {
  return n >= 1e6
    ? (n / 1e6).toFixed(1) + "M"
    : n >= 1e3
      ? (n / 1e3).toFixed(1) + "K"
      : String(n);
}
