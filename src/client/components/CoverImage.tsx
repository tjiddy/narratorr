import { useState, type ReactNode } from 'react';
import { resolveUrl } from '@/lib/url-utils';

interface CoverImageProps {
  src?: string | null | undefined;
  alt: string;
  fallback: ReactNode;
  className?: string | undefined;
  imgClassName?: string | undefined;
}

export function CoverImage({ src, alt, fallback, className = '', imgClassName }: CoverImageProps) {
  const [imageError, setImageError] = useState(false);

  const resolvedSrc = resolveUrl(src);
  if (!resolvedSrc || imageError) {
    return (
      <div className={`bg-muted flex items-center justify-center ${className}`}>
        {fallback}
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden shadow-lg ${className}`}>
      <img
        src={resolvedSrc}
        alt={alt}
        className={`w-full h-full object-cover ${imgClassName ?? ''}`}
        loading="lazy"
        onError={() => setImageError(true)}
      />
      <div className="absolute inset-0 ring-1 ring-inset ring-black/10" />
    </div>
  );
}
