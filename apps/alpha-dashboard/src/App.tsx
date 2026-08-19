import { useCallback, useEffect, useMemo, useState } from "react";

import type { DashboardSnapshot } from "./types";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

function fmtUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function fmtUsdAmount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `$${value.toFixed(2)}`;
}

function fmtRewardUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  const decimals = Math.abs(value) < 0.01 ? 6 : 2;
  return `$${value.toFixed(decimals)}`;
}

function fmtPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtShares(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return value.toFixed(3);
}

function totalLockedUsd(positions: DashboardSnapshot["positions"]): number | undefined {
  if (positions.length === 0) return 0;
  if (!positions.some((position) => Number.isFinite(position.lockedUsd))) return undefined;
  return positions.reduce((sum, position) => sum + (position.lockedUsd ?? 0), 0);
}

function fmtTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function marketUrl(slug?: string): string | undefined {
  if (slug && slug.trim().length > 0) return `https://www.alphaarcade.com/market/${slug}`;
  return undefined;
}

type MetricCard = {
  label: string;
  value: string;
};

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSnapshot = useCallback(async () => {
    setLoading((current) => (snapshot ? current : true));
    setError(null);
    try {
      const response = await fetch("/api/alpha/dashboard");
      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        data?: DashboardSnapshot;
      };
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      setSnapshot(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [snapshot]);

  useEffect(() => {
    void fetchSnapshot();
    const id = setInterval(() => {
      void fetchSnapshot();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchSnapshot]);

  const metrics = useMemo<MetricCard[]>(() => {
    if (!snapshot) return [];
    const positionLockedUsd = totalLockedUsd(snapshot.positions);
    const cards: MetricCard[] = [];
    if (snapshot.realPnl) {
      cards.push(
        { label: "Trading PnL", value: fmtUsd(snapshot.realPnl.tradingPnlUsd) },
        { label: "Rewards Received", value: fmtRewardUsd(snapshot.realPnl.rewardsReceivedUsd) },
        { label: "Cash (wallet+escrow)", value: fmtUsdAmount(snapshot.realPnl.cashUsdc) },
        { label: "Total Economic", value: fmtUsd(snapshot.realPnl.totalEconomicUsd) },
      );
    } else {
      cards.push(
        { label: "Trading PnL", value: fmtUsd(snapshot.overview.tradingPnl) },
        { label: "Estimated Rewards", value: fmtUsd(snapshot.overview.estimatedRewardsUsd) },
        { label: "Wallet USDC", value: fmtUsd(snapshot.walletBalances.usdc) },
      );
    }
    cards.push(
      { label: "Net Worth", value: fmtUsdAmount(snapshot.realPnl?.netWorthUsd) },
      { label: "Position Cost", value: fmtUsdAmount(positionLockedUsd) },
      { label: "Bid Exposure", value: fmtUsd(snapshot.overview.bidExposureUsd) },
      { label: "Open Orders", value: String(snapshot.overview.openOrders) },
      {
        label: "Active Reward Rate",
        value: `${fmtRewardUsd(snapshot.overview.activeRewardRateHourlyUsd)}/hour (${fmtRewardUsd(
          snapshot.overview.activeRewardRateDailyUsd,
        )}/day)`,
      },
      {
        label: "Reward Liquidity Share",
        value: fmtPercent(snapshot.overview.activeRewardLiquidityShare),
      },
    );
    return cards;
  }, [snapshot]);

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-overlay">
          <img className="hero-mark" src="/assets/ghillie-mark.png" alt="Ghillie emblem" />
          <div>
            <h1>Ghillie Alpha Dashboard</h1>
            <p>Read-only position and digest monitor</p>
          </div>
        </div>
      </header>

      <main className="content">
        <section className="card warning">
          <h2>Deprecated</h2>
          <p>
            This local ops dashboard is deprecated. Use the public Ghillie showcase on{" "}
            <a href="https://amarok.compx.io/user-agents" target="_blank" rel="noopener noreferrer">
              amarok.compx.io/user-agents
            </a>
            .
          </p>
        </section>
        {error && <section className="card error">Error: {error}</section>}
        {loading && !snapshot && <section className="card">Loading dashboard...</section>}

        {snapshot && (
          <>
            {snapshot.health.errors.length > 0 && (
              <section className="card warning">
                <h2>Data Warnings</h2>
                <ul>
                  {snapshot.health.errors.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            )}

            <section className="metrics-grid">
              {metrics.map((card) => (
                <article
                  key={card.label}
                  className={`metric-card card${card.label === "Total Economic" ? " metric-card-primary" : ""}`}
                >
                  <h3>{card.label}</h3>
                  <p>{card.value}</p>
                </article>
              ))}
            </section>

            {snapshot.realPnl && (
              <section className="card">
                <h2>Accountancy (split ledgers)</h2>
                <ul className="reconciliation-list">
                  <li>
                    Trading: realised {fmtUsd(snapshot.realPnl.realisedPnlUsd)} | unrealised{" "}
                    {fmtUsd(snapshot.realPnl.unrealisedPnlUsd)} | total{" "}
                    {fmtUsd(snapshot.realPnl.tradingPnlUsd)}
                  </li>
                  <li>
                    Rewards received (on-chain): {fmtRewardUsd(snapshot.realPnl.rewardsReceivedUsd)}{" "}
                    | est accrual {fmtRewardUsd(snapshot.realPnl.estimatedRewardsUsd)}
                  </li>
                  <li>
                    Cash: wallet {fmtUsdAmount(snapshot.realPnl.walletUsdc)} | bid escrow{" "}
                    {fmtUsdAmount(snapshot.realPnl.bidEscrowUsd)} | total{" "}
                    {fmtUsdAmount(snapshot.realPnl.cashUsdc)}
                  </li>
                  <li>
                    Total economic (trading + rewards): {fmtUsd(snapshot.realPnl.totalEconomicUsd)}
                  </li>
                  <li>Positions value: {fmtUsdAmount(snapshot.realPnl.positionsValueUsd)}</li>
                  <li>
                    Net worth (cash + positions): {fmtUsdAmount(snapshot.realPnl.netWorthUsd)}
                  </li>
                  <li>
                    Market USDC in (lifetime): {fmtUsdAmount(snapshot.realPnl.marketUsdcInUsd)}
                  </li>
                  <li>
                    Market USDC out (lifetime): {fmtUsdAmount(snapshot.realPnl.marketUsdcOutUsd)}
                  </li>
                  {snapshot.realPnl.ledgerCachedAt && (
                    <li>Flow data as of: {fmtTime(snapshot.realPnl.ledgerCachedAt)}</li>
                  )}
                </ul>
                {Math.abs(snapshot.realPnl.externalCapitalDriftUsd) > 0.05 && (
                  <p className="warning-inline">
                    External capital drift vs historical seed:{" "}
                    {fmtUsd(snapshot.realPnl.externalCapitalDriftUsd)} (diagnostic only — not
                    trading PnL)
                  </p>
                )}
              </section>
            )}

            <section className="layout-grid">
              <article className="card table-card">
                <div className="section-heading">
                  <h2>Positions ({snapshot.positions.length})</h2>
                  <p>{fmtUsdAmount(totalLockedUsd(snapshot.positions))} locked</p>
                </div>
                {snapshot.positions.length === 0 ? (
                  <p className="empty">No open positions found.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Outcome</th>
                        <th>Shares</th>
                        <th>Locked</th>
                        <th>Avg Cost</th>
                        <th>Mark</th>
                        <th>Unrealized</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.positions.map((position) => {
                        const url = marketUrl(position.slug);
                        return (
                          <tr
                            key={`${position.marketId}:${position.outcome}`}
                            className={url ? "clickable-row" : undefined}
                            onClick={() => {
                              if (url) window.open(url, "_blank", "noopener,noreferrer");
                            }}
                          >
                            <td>{position.title}</td>
                            <td>{position.outcome}</td>
                            <td>{fmtShares(position.shares)}</td>
                            <td>{fmtUsdAmount(position.lockedUsd)}</td>
                            <td>{fmtPrice(position.avgCost)}</td>
                            <td>{fmtPrice(position.mark)}</td>
                            <td>{fmtUsd(position.unrealisedPnl)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </article>

              <article className="card table-card">
                <h2>Open Orders ({snapshot.openOrders.length})</h2>
                {snapshot.openOrders.length === 0 ? (
                  <p className="empty">No open orders.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Side</th>
                        <th>Source</th>
                        <th>Price</th>
                        <th>Remaining</th>
                        <th>Notional</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.openOrders.map((order) => {
                        const url = marketUrl(order.slug);
                        return (
                          <tr
                            key={order.id}
                            className={url ? "clickable-row" : undefined}
                            onClick={() => {
                              if (url) window.open(url, "_blank", "noopener,noreferrer");
                            }}
                          >
                            <td>{order.title}</td>
                            <td>
                              {order.outcome} {order.side}
                            </td>
                            <td>{order.source}</td>
                            <td>{fmtPrice(order.price)}</td>
                            <td>{fmtShares(order.remainingShares)}</td>
                            <td>{fmtUsd(order.notionalUsd)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </article>

              <article className="card table-card full-width">
                <h2>Recent Activity ({snapshot.activity.length})</h2>
                {snapshot.activity.length === 0 ? (
                  <p className="empty">No recent fill/cancel activity.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        <th>Market</th>
                        <th>Side</th>
                        <th>Shares</th>
                        <th>Price</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.activity.map((item) => (
                        <tr key={item.id}>
                          <td>{fmtTime(item.updatedAt)}</td>
                          <td>{item.type}</td>
                          <td>{item.title}</td>
                          <td>
                            {item.outcome} {item.side}
                          </td>
                          <td>{fmtShares(item.shares)}</td>
                          <td>{fmtPrice(item.price)}</td>
                          <td>{item.reason || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
