import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { getConfig, type ChainConfig } from './api';
import { connect, ensureChain, forgetToken, getProvider, onAccountsChanged, savedToken, signIn, walletErrorText } from './wallet';

export interface WalletState {
  cfg: ChainConfig | null;
  hasWallet: boolean;
  address: Address | null;
  token: string | null;
  busy: string | null;
  error: string | null;
}

/**
 * Wallet connection + sign-in, shared by the host and player screens.
 * Steps: connect -> switch/add the game network -> sign the login message.
 */
export function useWallet(statement: string) {
  const [s, set] = useState<WalletState>({
    cfg: null,
    hasWallet: !!getProvider(),
    address: null,
    token: null,
    busy: null,
    error: null,
  });

  useEffect(() => {
    getConfig()
      .then((cfg) => set((p) => ({ ...p, cfg })))
      .catch((e) => set((p) => ({ ...p, error: `Сервер недоступен: ${(e as Error).message}` })));
    // Wallets that inject the provider late (some mobile in-app browsers).
    const t = setTimeout(() => set((p) => ({ ...p, hasWallet: !!getProvider() })), 500);
    return () => clearTimeout(t);
  }, []);

  useEffect(
    () =>
      onAccountsChanged((accounts) => {
        set((p) => ({ ...p, address: null, token: null, error: accounts.length ? null : p.error }));
      }),
    [],
  );

  const login = useCallback(async () => {
    const cfg = s.cfg ?? (await getConfig());
    try {
      set((p) => ({ ...p, busy: 'Подключаем кошелёк…', error: null }));
      const address = await connect();
      set((p) => ({ ...p, busy: 'Добавляем сеть «Криптополия» в кошелёк…', address }));
      await ensureChain(cfg);
      let token = savedToken(address);
      if (!token) {
        set((p) => ({ ...p, busy: 'Подпишите сообщение для входа…' }));
        token = await signIn(address, cfg, statement);
      }
      set((p) => ({ ...p, cfg, address, token, busy: null }));
      return { address, token };
    } catch (e) {
      set((p) => ({ ...p, busy: null, error: walletErrorText(e) }));
      return null;
    }
  }, [s.cfg, statement]);

  /** Call when the backend answers 401: the saved token expired. */
  const expire = useCallback(() => {
    if (s.address) forgetToken(s.address);
    set((p) => ({ ...p, token: null }));
  }, [s.address]);

  const setError = useCallback((error: string | null) => set((p) => ({ ...p, error })), []);

  return { ...s, login, expire, setError };
}
