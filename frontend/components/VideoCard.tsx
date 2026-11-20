
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Heart, Play } from 'lucide-react';
import { API, api, Video, time, short } from '@/lib/api';

type LikeResponse = {
  liked: boolean;
  likesCount: number;
};

export default function VideoCard({ video: v }: { video: Video }) {
  const [liked, setLiked] = useState(false);
  const [likesCount, setLikesCount] = useState(v.count?.likes ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    setLiked(false);
    setLikesCount(v.count?.likes ?? 0);

    api<LikeResponse>(`/api/videos/${v.id}/like`)
      .then(data => {
        if (active) {
          setLiked(data.liked);
          setLikesCount(data.likesCount);
        }
      })
      .catch(() => {
        // Anonymous users can still see the public like count.
      });

    return () => {
      active = false;
    };
  }, [v.id, v.count?.likes]);

  async function toggleLike() {
    if (loading) return;

    setLoading(true);
    setError('');

    try {
      const data = await api<LikeResponse>(
        `/api/videos/${v.id}/like`,
        { method: 'POST' }
      );

      setLiked(data.liked);
      setLikesCount(data.likesCount);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unable to like video';

      if (
        message === 'Login required' ||
        message === 'Invalid session'
      ) {
        window.location.href = '/login';
        return;
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="video-card">
      <Link href={`/video/${v.id}`} className="block">
        <div className="relative">
          {v.thumbnail ? (
            <img
              src={`${API}/api/videos/${v.id}/thumbnail`}
              alt={v.title}
            />
          ) : (
            <div className="placeholder">
              <Play />
            </div>
          )}

          <span className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 text-xs rounded">
            {time(v.duration)}
          </span>
        </div>

        <div className="p-3 pb-1">
          <h3 className="font-semibold line-clamp-2">
            {v.title}
          </h3>

          <p className="muted text-sm mt-1">
            {v.category.name} · {short(v.views)} views
          </p>
        </div>
      </Link>

      <div className="px-3 pb-3 pt-2">
        <button
          type="button"
          onClick={toggleLike}
          disabled={loading}
          aria-pressed={liked}
          aria-label={liked ? 'Unlike video' : 'Like video'}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
            liked
              ? 'bg-pink-600/20 text-pink-400'
              : 'bg-white/5 text-gray-300 hover:bg-pink-600/20'
          }`}
        >
          <Heart
            size={19}
            fill={liked ? 'currentColor' : 'none'}
          />
          <span>{short(likesCount)}</span>
          <span>{liked ? 'Liked' : 'Like'}</span>
        </button>

        {error && (
          <p className="text-red-400 text-xs mt-2" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
