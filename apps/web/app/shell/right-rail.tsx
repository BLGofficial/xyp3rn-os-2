// A page's right rail (AOS-04 design §13.1): pulse and activity on Command, the evidence column on a run.
// Beside the content from 1280 px; stacked after it below.
export const WithRail = ({ children, rail, label }: { children: React.ReactNode; rail: React.ReactNode; label: string }) => (
  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_304px] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-5">
    <div className="min-w-0">{children}</div>
    <aside aria-label={label} className="flex min-w-0 flex-col gap-4">{rail}</aside>
  </div>
);
