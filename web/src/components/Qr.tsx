import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function Qr({ value, size = 240, label }: { value: string; size?: number; label?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((d) => alive && setSrc(d))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  return (
    <figure className="qr" style={{ width: size }}>
      {src ? <img src={src} width={size} height={size} alt={label ?? value} /> : <div style={{ width: size, height: size }} />}
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}
