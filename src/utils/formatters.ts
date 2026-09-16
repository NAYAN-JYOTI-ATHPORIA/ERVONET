export function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const seconds = d.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function formatTimeAgo(timestamp: number): string {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const elapsedSec = Math.floor(elapsedMs / 1000);

  if (elapsedSec < 3) return 'just now';
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const elapsedHrs = Math.floor(elapsedMin / 60);
  return `${elapsedHrs}h ago`;
}

export function generateMessageId(senderId: string): string {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const timeHex = Date.now().toString(16).slice(-4).toUpperCase();
  return `MSG-${senderId.slice(-4)}-${timeHex}${rand}`;
}

