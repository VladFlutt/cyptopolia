import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address as Addr } from 'viem';
import { ApiError, ZERO, api, fmt, type PlayerState, type SessionView } from '../api';
import { Qr } from '../components/Qr';
import { Address, Header, Notice, StatusBadge } from '../components/ui';
import { useWallet } from '../useWallet';
import { isMobile, sendToken, walletDeepLinks, walletErrorText, watchAsset } from '../wallet';

export function Player({ code }: { code: string }) {
  const w = useWallet('Вход игрока в Криптополию');
  const [pub, setPub] = useState<SessionView | null>(null);
  const [state, setState] = useState<PlayerState | null>(null);
  const [joined, setJoined] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SessionView>(`/api/join/${code}`)
      .then(setPub)
      .catch((e) => setError((e as Error).message));
  }, [code]);

  const refresh = useCallback(() => {
    if (!w.token) return;
    api<PlayerState>(`/api/join/${code}/me`, { token: w.token })
      .then((s) => {
        setState(s);
        setJoined(true);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) w.expire();
        else if (e instanceof ApiError && e.status === 403) setJoined(false);
        else setError((e as Error).message);
      });
  }, [code, w.token, w.expire]);

  useEffect(() => {
    refresh();
    if (!w.token) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, w.token]);

  const session = state?.session ?? pub;
  const right = w.address ? <Address value={w.address} label="Вы" /> : null;

  return (
    <>
      <Header right={right} />
      <main className="page narrow">
        {session && (
          <div className="title-row">
            <h1>{session.title}</h1>
            <StatusBadge status={session.status} />
          </div>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        {w.error && <Notice kind="error">{w.error}</Notice>}
        {w.busy && <Notice>{w.busy}</Notice>}

        {session?.status === 'stopped' && <Results session={session} me={w.address} />}

        {session?.status === 'active' && !w.hasWallet && <OpenInWallet />}

        {session?.status === 'active' && w.hasWallet && !w.token && (
          <section className="card">
            <h2>Шаг 1. Подключите кошелёк</h2>
            <p>
              Кошелёк попросит три подтверждения: доступ к адресу, добавление сети «Криптополия» и подпись сообщения для
              входа. Подпись бесплатная и ничего не отправляет.
            </p>
            <p className="muted small">
              Совет: для игры заведите в кошельке отдельный счёт и не храните на нём настоящие деньги.
            </p>
            <button type="button" className="big" disabled={!!w.busy || !w.cfg} onClick={() => void w.login()}>
              Подключить кошелёк
            </button>
          </section>
        )}

        {session?.status === 'active' && w.token && joined === false && (
          <JoinForm
            session={session}
            onJoin={async (name) => {
              setError(null);
              try {
                await api(`/api/join/${code}`, { method: 'POST', token: w.token, body: { name } });
                refresh();
              } catch (e) {
                if (e instanceof ApiError && e.status === 401) w.expire();
                setError((e as Error).message);
              }
            }}
          />
        )}

        {session?.status === 'active' && state && w.address && w.cfg && (
          <Wallet state={state} me={w.address} onSent={refresh} cfg={w.cfg} />
        )}
      </main>
    </>
  );
}

function OpenInWallet() {
  const links = walletDeepLinks();
  return (
    <section className="card">
      <h2>Откройте страницу в кошельке</h2>
      {isMobile() ? (
        <>
          <p>Эта страница работает во встроенном браузере криптокошелька. Выберите свой кошелёк:</p>
          <div className="wallet-links">
            {links.map((l) => (
              <a key={l.name} className="button" href={l.href}>
                {l.name}
              </a>
            ))}
          </div>
          <p className="muted small">
            Кошелька ещё нет? Установите MetaMask или Trust Wallet из магазина приложений, создайте новый кошелёк и
            запишите секретную фразу на бумагу. Затем вернитесь к QR-коду.
          </p>
        </>
      ) : (
        <>
          <p>
            На компьютере установите расширение кошелька (например, MetaMask) и обновите страницу. Или отсканируйте этот
            код телефоном с установленным кошельком:
          </p>
          <Qr value={window.location.href} size={200} />
        </>
      )}
    </section>
  );
}

function JoinForm({ session, onJoin }: { session: SessionView; onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const full = session.players.length >= session.maxPlayers;
  return (
    <section className="card">
      <h2>Шаг 2. Займите место за столом</h2>
      <p>
        Мест занято: {session.players.length} из {session.maxPlayers}. После входа вы получите{' '}
        <strong>{fmt(session.startBalance)} USDG</strong> и немного CPL для оплаты газа.
      </p>
      {full ? (
        <Notice kind="error">Все места заняты.</Notice>
      ) : (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onJoin(name);
            setBusy(false);
          }}
        >
          <input
            aria-label="Ваше имя в игре"
            placeholder="Имя или ник"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Записываем в блокчейн…' : 'Войти в партию'}
          </button>
        </form>
      )}
    </section>
  );
}

function Wallet({
  state,
  me,
  cfg,
  onSent,
}: {
  state: PlayerState;
  me: Addr;
  cfg: NonNullable<ReturnType<typeof useWallet>['cfg']>;
  onSent: () => void;
}) {
  const s = state.session;
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [to, setTo] = useState(s.bank ?? '');
  const [symbol, setSymbol] = useState('USDG');
  const [amount, setAmount] = useState('');
  const [showQr, setShowQr] = useState<string | null>(null);
  const total = state.balances.reduce((a, b) => a + b.valueUsdg, 0);
  const myAddr = me.toLowerCase();

  const names = useMemo(() => {
    const m = new Map<string, string>([[ZERO, 'Выпуск']]);
    if (s.bank) m.set(s.bank, 'Банк');
    s.players.forEach((p) => m.set(p.address, p.address === myAddr ? 'Вы' : p.name));
    return m;
  }, [s, myAddr]);

  const recipients = [
    ...(s.bank ? [{ address: s.bank, name: 'Банк' }] : []),
    ...s.players.filter((p) => p.address !== myAddr),
  ];

  async function send() {
    const token = s.tokens.find((t) => t.symbol === symbol)!;
    setMsg({ kind: 'info', text: 'Подтвердите перевод в кошельке…' });
    try {
      const hash = await sendToken(cfg, me, token, to, amount);
      setMsg({ kind: 'ok', text: `Отправлено. Транзакция ${hash.slice(0, 10)}…` });
      setAmount('');
      setTimeout(onSent, 2500);
    } catch (e) {
      setMsg({ kind: 'error', text: walletErrorText(e) });
    }
  }

  return (
    <>
      <section className="card">
        <div className="title-row">
          <h2>Мой портфель</h2>
          <span className="total">{fmt(total, 0)} USDG</span>
        </div>
        <table className="table compact">
          <thead>
            <tr>
              <th>Токен</th>
              <th className="num">Количество</th>
              <th className="num">≈ USDG</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.balances.map((b) => {
              const t = s.tokens.find((x) => x.symbol === b.symbol)!;
              return (
                <tr key={b.symbol} className={Number(b.amount) === 0 ? 'dim' : ''}>
                  <td>
                    <strong>{b.symbol}</strong>
                    <div className="muted small">{t.name}</div>
                  </td>
                  <td className="num">{fmt(b.amount)}</td>
                  <td className="num">{fmt(b.valueUsdg, 0)}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost small"
                      title="Показать токен в кошельке"
                      onClick={() =>
                        watchAsset(t).catch((e) => setMsg({ kind: 'error', text: walletErrorText(e) }))
                      }
                    >
                      + в кошелёк
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small">
          «В кошелёк» добавляет токен в список активов кошелька, чтобы видеть баланс и там. Курсы задаёт ведущий.
        </p>
      </section>

      <section className="card">
        <h2>Перевод</h2>
        <p className="muted small">
          Платите здесь или прямо из кошелька кнопкой «Отправить». Адреса участников ниже, их можно скопировать.
        </p>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <form
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label>
            Кому
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {recipients.map((r) => (
                <option key={r.address} value={r.address}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Токен
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {s.tokens.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </label>
          <label>
            Сумма
            <input inputMode="decimal" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button type="submit" disabled={!to || !amount}>
            Отправить
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Участники</h2>
        <ul className="people">
          {recipients.map((r) => (
            <li key={r.address}>
              <span>{r.name}</span>
              <Address value={r.address} />
              <button type="button" className="ghost small" onClick={() => setShowQr(showQr === r.address ? null : r.address)}>
                QR
              </button>
              {showQr === r.address && <Qr value={r.address} size={160} label={r.name} />}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Мои переводы</h2>
        {state.transfers.length === 0 ? (
          <p className="muted">Пока пусто.</p>
        ) : (
          <ul className="feed">
            {state.transfers.map((t) => {
              const incoming = t.to === myAddr;
              return (
                <li key={`${t.tx}-${t.symbol}-${t.to}`} className={incoming ? 'in' : 'out'}>
                  <span className="amount">
                    {incoming ? '+' : '−'}
                    {fmt(t.amount)} {t.symbol}
                  </span>
                  <span className="muted">
                    {incoming ? `от: ${names.get(t.from) ?? t.from.slice(0, 8)}` : `кому: ${names.get(t.to) ?? t.to.slice(0, 8)}`} · блок{' '}
                    {t.block}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function Results({ session, me }: { session: SessionView; me: string | null }) {
  const rows = session.results ?? [];
  return (
    <section className="card">
      <h2>Партия завершена</h2>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок</th>
            <th className="num">Капитал, USDG</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address} className={me && r.address === me.toLowerCase() ? 'me' : ''}>
              <td>{r.place}</td>
              <td>{r.name}</td>
              <td className="num strong">{fmt(r.totalUsdg, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
