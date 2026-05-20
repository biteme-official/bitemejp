import { useEffect, useState } from "react";
import { Play, Instagram, X } from "lucide-react";

interface Reel {
  id: string;
  media_type: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  caption?: string;
  timestamp: string;
}

export function InstagramReels() {
  const [reels, setReels] = useState<Reel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReel, setSelectedReel] = useState<Reel | null>(null);

  useEffect(() => {
    fetch("/api/instagram-reels")
      .then((r) => r.json())
      .then((data) => {
        if (data.reels) setReels(data.reels);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (!loading && reels.length === 0) return null;

  return (
    <>
    <section className="py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Instagram className="h-5 w-5 text-pink-500" />
          <h2 className="text-lg font-bold">インスタで見てね🐶</h2>
          <a
            href="https://www.instagram.com/biteme_jp/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-pink-500 transition-colors"
          >
            @biteme_jp
          </a>
        </div>

        {loading ? (
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex-none w-36 aspect-[9/16] bg-muted animate-pulse rounded-xl"
              />
            ))}
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2 snap-x snap-mandatory">
            {reels.map((reel) => (
              <button
                key={reel.id}
                onClick={() => setSelectedReel(reel)}
                className="flex-none w-36 aspect-[9/16] relative rounded-xl overflow-hidden bg-muted group cursor-pointer snap-start"
              >
                <img
                  src={reel.thumbnail_url || reel.media_url}
                  alt={reel.caption?.slice(0, 40) || "Instagram Reel"}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="bg-white/90 rounded-full p-2">
                    <Play className="h-5 w-5 text-black fill-black" />
                  </div>
                </div>
                <div className="absolute bottom-2 left-2">
                  <div className="bg-black/60 rounded-full p-1">
                    <Play className="h-3 w-3 text-white fill-white" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>

      {selectedReel && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelectedReel(null)}
        >
          <div
            className="relative w-full max-w-sm aspect-[9/16] rounded-2xl overflow-hidden bg-black"
            onClick={(e) => e.stopPropagation()}
          >
            <iframe
              src={`${selectedReel.permalink}embed/`}
              className="w-full h-full border-0"
              allowFullScreen
              allow="autoplay; encrypted-media"
            />
            <button
              onClick={() => setSelectedReel(null)}
              className="absolute top-3 right-3 z-10 bg-black/60 rounded-full p-1.5 text-white hover:bg-black/80 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
