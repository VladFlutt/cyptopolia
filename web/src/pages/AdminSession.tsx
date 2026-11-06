import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, ZERO, api, fmt, type SessionDetails, type Standing } from '../api';
import { navigate } from '../App';
import { Qr } from '../components/Qr';
import { Address, Notice, StatusBadge } from '../components/ui';

interface Props {
  id: number;
  token: string;
  onAuthExpired: () => void;
}

export function AdminSession({ id, token, onAuthExpired }: Props) {
  const [s, setS] = useState<SessionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onAuthExpired();
      setError((e as Error).message);
    },
    [onAuthExpired],
  );

  const load = useCallback(() => {
    api<SessionDetails>(`/api/sessions/${id}`, { token })
      .then((d) => {
        setS(d);
        setError(null);
      })
      .catch(handle);
  }, [id, token, handle]);

  // Refresh on every transfer (SSE) and every 5 s as a fallback.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/sessions/${id}/events?token=${encodeURIComponent(token)}`);
      es.addEventListener('transfer', () => load());
    } catch {
      /* polling only */
    }
    return () => {
      clearInterval(t);
      es?.close();
    };
  }, [id, token, load]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    m.set(ZERO, 'Выпуск');
    if (s?.bank) m.set(s.bank, 'Банк');
    s?.players.forEach((p) => m.set(p.address, p.name));
    return m;
  }, [s]);

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError(null);
    setInfo(null);
    try {
      await fn();
      if (done) setInfo(done);
      load();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(null);
    }
  }

  if (!s) {
    return <main className="page">{error ? <Notice kind="error">{error}</Notice> : <p className="muted">Загрузка…</p>}</main>;
  }

  const active = s.status === 'active';
  const ranking: Standing[] = s.results ?? s.standings ?? [];

  return (
    <main className="page wide">
      <div className="crumbs">
        <a
          href="/admin"
          onClick={(e) => {
            e.preventDefault();
            navigate('/admin');
          }}
        >
          ← Мои партии
        </a>
      </div>
      <div className="title-row">
        <h1>{s.title}</h1>
        <StatusBadge status={s.status} />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="ok">{info}</Notice>}
      {busy && <Notice>{busy}</Notice>}

      <div className="layout">
        {active && (
          <section className="card join-card">
            <h2>Подключение игроков</h2>
            <Qr value={s.joinUrl} size={260} />
            <p className="join-code">
              Код: <strong>{s.code}</strong>
            </p>
            <p className="muted small">
              Отсканируйте QR-код камерой телефона или сканером в кошельке. Можно открыть <code>{s.joinUrl}</code>.
            </p>
            <p>
              Игроков: <strong>{s.players.length}</strong> из {s.maxPlayers}
            </p>
          </section>
        )}

        <section className="card grow">
          <h2>{s.status === 'stopped' ? 'Итоги партии' : 'Рейтинг по текущим курсам'}</h2>
          {ranking.length === 0 ? (
            <p className="muted">Игроки ещё не подключились.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Игрок</th>
                  <th className="num">Капитал, USDG</th>
                  <th>Портфель</th>
                  {active && <th />}
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.address}>
                    <td>{r.place}</td>
                    <td>
                      <div>{r.name}</div>
                      <Address value={r.address} />
                    </td>
                    <td className="num strong">{fmt(r.totalUsdg, 0)}</td>
                    <td>
                      <div className="holdings">
                      {r.holdings
                        .filter((h) => Number(h.amount) > 0)
                        .map((h) => (
                          <span key={h.symbol} className="chip">
                            {fmt(h.amount)} {h.symbol}
                          </span>
                        ))}
                      </div>
                    </td>
                    {active && (
                      <td>
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() =>
                            void run(
                              `Отправляем газ игроку ${r.name}…`,
                              () => api(`/api/sessions/${id}/gas`, { method: 'POST', token, body: { to: r.address } }),
                              `Газ отправлен игроку ${r.name}`,
                            )
                          }
                        >
                          + газ
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {active && (
        <div className="layout">
          <PayForm
            s={s}
            disabled={!!busy}
            onPay={(body, who) =>
              run(
                'Банк отправляет перевод…',
                () => api(`/api/sessions/${id}/pay`, { method: 'POST', token, body }),
                `Банк перевёл ${body.amount} ${body.token} → ${who}`,
              )
            }
          />
          <PriceBoard
            s={s}
            disabled={!!busy}
            onSave={(prices) =>
              run('Сохраняем курсы…', () => api(`/api/sessions/${id}/prices`, { method: 'PUT', token, body: prices }), 'Курсы обновлены')
            }
          />
        </div>
      )}

      {!active && <PriceBoard s={s} disabled onSave={() => {}} />}

      <section className="card">
        <h2>Лента переводов</h2>
        {s.transfers.length === 0 ? (
          <p className="muted">Переводов пока нет.</p>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>Блок</th>
                <th>Откуда</th>
                <th>Куда</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {s.transfers
                .filter((t) => !(t.from === ZERO && t.to === s.bank))
                .map((t) => (
                <tr key={`${t.tx}-${t.symbol}-${t.to}`}>
                  <td>{t.block}</td>
                  <td>{names.get(t.from) ?? <Address value={t.from} />}</td>
                  <td>{names.get(t.to) ?? <Address value={t.to} />}</td>
                  <td className="num">
                    {fmt(t.amount)} {t.symbol}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {active && (
        <section className="card danger-zone">
          <h2>Завершение</h2>
          <p>Остановка замораживает все токены партии и фиксирует итоговый рейтинг по текущим курсам. Отменить её нельзя.</p>
          <button
            type="button"
            className="danger"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm('Остановить партию? Переводы станут невозможны, а рейтинг зафиксируется.'))
                void run('Останавливаем партию…', () => api(`/api/sessions/${id}/stop`, { method: 'POST', token }), 'Партия завершена');
            }}
          >
            Остановить партию
          </button>
        </section>
      )}
    </main>
  );
}

function PayForm({
  s,
  disabled,
  onPay,
}: {
  s: SessionDetails;
  disabled: boolean;
  onPay: (body: { to: string; token: string; amount: string }, who: string) => void;
}) {
  const [to, setTo] = useState('all');
  const [token, setToken] = useState('USDG');
  const [amount, setAmount] = useState('200');
  const price = s.tokens.find((t) => t.symbol === token)?.price ?? 0;
  const who = to === 'all' ? 'всем игрокам' : (s.players.find((p) => p.address === to)?.name ?? to);
  return (
    <section className="card grow">
      <h2>Платёж из банка</h2>
      <p className="muted small">Зарплата за круг, выплата по карточке, продажа токена игроку.</p>
      <form
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          onPay({ to, token, amount }, who);
        }}
      >
        <label>
          Кому
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="all">Всем игрокам</option>
            {s.players.map((p) => (
              <option key={p.address} value={p.address}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Токен
          <select value={token} onChange={(e) => setToken(e.target.value)}>
            {s.tokens.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol} · {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Сумма
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button type="submit" disabled={disabled || s.players.length === 0 || !amount}>
          Отправить
        </button>
      </form>
      {token !== 'USDG' && Number(amount.replace(',', '.')) > 0 && (
        <p className="muted small">
          По текущему курсу это {fmt(Number(amount.replace(',', '.')) * price, 2)} USDG
        </p>
      )}
    </section>
  );
}

function PriceBoard({ s, disabled, onSave }: { s: SessionDetails; disabled: boolean; onSave: (p: Record<string, number>) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const changed = Object.keys(draft).length > 0;
  return (
    <section className="card grow">
      <h2>Табло курсов</h2>
      <table className="table compact prices">
        <thead>
          <tr>
            <th>Токен</th>
            <th>Аналог</th>
            <th className="num">Цена, USDG</th>
          </tr>
        </thead>
        <tbody>
          {s.tokens.map((t) => (
            <tr key={t.symbol}>
              <td>
                <strong>{t.symbol}</strong> <span className="muted">{t.name}</span>
              </td>
              <td className="muted">{t.realWorld}</td>
              <td className="num">
                {disabled ? (
                  fmt(t.price)
                ) : (
                  <input
                    className="price-input"
                    inputMode="decimal"
                    aria-label={`Цена ${t.symbol}`}
                    value={draft[t.symbol] ?? String(t.price)}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.symbol]: e.target.value }))}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && (
        <button
          type="button"
          disabled={!changed}
          onClick={() => {
            const out: Record<string, number> = {};
            for (const [k, v] of Object.entries(draft)) out[k] = Number(v.replace(',', '.'));
            onSave(out);
            setDraft({});
          }}
        >
          Сохранить курсы
        </button>
      )}
    </section>
  );
}
