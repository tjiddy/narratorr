import { useState, type ReactNode } from 'react';

interface CoverImageProps {
  src?: string | null;
  alt: string;
  fallback: ReactNode;
  className?: string;
  imgClassName?: string;
}

export function CoverImage({ src, alt, fallback, className = '', imgClassName }: CoverImageProps) {
  const [imageError, setImageError] = useState(false);

  if (!src || imageError) {
    return (
      <div className={`bg-muted flex items-center justify-center ${className}`}>
        {fallback}
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden shadow-lg ${className}`}>
      <img
        src={src}
        alt={alt}
        className={`w-full h-full object-cover ${imgClassName ?? ''}`}
        loading="lazy"
        onError={() => setImageError(true)}
      />
      <div className={`absolute inset-0 ring-1 ring-inset ring-black/10 ${className}`} />
    </div>
  );
}
