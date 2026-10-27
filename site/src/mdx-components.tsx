import { Frame } from '@inkform/framework/components';

/**
 * A screenshot in the setup guides. Until site/public/screenshots/<file> is
 * recorded it renders as a placeholder naming that file; add `alt` once the
 * image exists and the same tag shows it, so the MDX never has to change shape.
 */
export function Screenshot({ file, caption, alt }: { file: string; caption: string; alt?: string }) {
  const src = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/screenshots/${file}`;
  return (
    <Frame caption={caption}>
      {alt ? (
        <img src={src} alt={alt} />
      ) : (
        <div className="shot" data-shot={file}>
          Screenshot coming
        </div>
      )}
    </Frame>
  );
}
