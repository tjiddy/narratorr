const protocolConfig = {
  torrent: {
    label: 'Torrent',
    className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  usenet: {
    label: 'Usenet',
    className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
} as const;

export function ProtocolBadge({ protocol }: { protocol: 'torrent' | 'usenet' }) {
  const config = protocolConfig[protocol];
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${config.className}`}
      data-testid="protocol-badge"
    >
      {config.label}
    </span>
  );
}
