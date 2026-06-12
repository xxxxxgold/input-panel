export function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function UsageMetricDetailItem({
  label,
  value,
  description
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="detail-item usage-metric-detail-item">
      <div className="usage-metric-detail-copy">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </div>
      <strong>{value}</strong>
    </div>
  );
}
