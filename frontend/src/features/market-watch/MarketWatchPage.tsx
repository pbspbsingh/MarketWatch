const panels = ["Industries / Themes", "Tickers", "Chart"] as const;

export function MarketWatchPage() {
  return (
    <section className="market-watch-page" aria-label="Market Watch">
      {panels.map((panel) => (
        <section className="workspace-panel" key={panel}>
          <header className="panel-header">{panel}</header>
          <div className="panel-empty">Pending implementation</div>
        </section>
      ))}
    </section>
  );
}
