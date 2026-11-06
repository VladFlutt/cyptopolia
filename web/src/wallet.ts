import { createWalletClient, custom, defineChain, getAddress, parseUnits, type Address, type EIP1193Provider } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { api, type ChainConfig, type TokenInfo } from './api';

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isMetaMask?: boolean };
  }
}

export function getProvider(): EIP1193Provider | null {
  return typeof window !== 'undefined' && window.ethereum ? window.ethereum : null;
}

export function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Links that open the current page inside a wallet's built-in browser. */
export function walletDeepLinks(url = window.location.href) {
  const noProto = url.replace(/^https?:\/\//, '');
  const enc = encodeURIComponent(url);
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${noProto}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { name: 'OKX Wallet', href: `okx://wallet/dapp/url?dappUrl=${enc}` },
  ];
}

export function toChain(cfg: ChainConfig) {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
}

function provider(): EIP1193Provider {
  const p = getProvider();
  if (!p) throw new Error('Кошелёк не найден. Откройте страницу в браузере кошелька или установите расширение.');
  return p;
}

export async function connect(): Promise<Address> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts[0]) throw new Error('Кошелёк не дал доступ к адресу');
  return getAddress(accounts[0]);
}

export async function currentChainId(): Promise<number> {
  return parseInt((await provider().request({ method: 'eth_chainId' })) as string, 16);
}

/** Switches the wallet to the game network, adding it first if the wallet does not know it. */
export async function ensureChain(cfg: ChainConfig): Promise<void> {
  if ((await currentChainId()) === cfg.chainId) return;
  try {
    await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: cfg.chainIdHex }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } }).code;
    const inner = (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && inner !== 4902 && code !== -32603) throw e;
    await provider().request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: cfg.chainIdHex,
          chainName: cfg.chainName,
          nativeCurrency: cfg.nativeCurrency,
          rpcUrls: cfg.rpcUrls,
        },
      ],
    });
  }
}

const tokenKey = (address: string) => `cryptopolia:auth:${address.toLowerCase()}`;

export function savedToken(address: string): string | null {
  try {
    return localStorage.getItem(tokenKey(address));
  } catch {
    return null;
  }
}

export function forgetToken(address: string) {
  try {
    localStorage.removeItem(tokenKey(address));
  } catch {
    /* storage unavailable */
  }
}

/** Sign-In with Ethereum: the wallet signs a text message; the backend returns a session token. */
export async function signIn(address: Address, cfg: ChainConfig, statement: string): Promise<string> {
  const { nonce } = await api<{ nonce: string }>('/api/auth/nonce', { method: 'POST', body: {} });
  const message = createSiweMessage({
    domain: window.location.host,
    address,
    chainId: cfg.chainId,
    nonce,
    uri: window.location.origin,
    version: '1',
    statement,
  });
  const client = createWalletClient({ transport: custom(provider()) });
  const signature = await client.signMessage({ account: address, message });
  const { token } = await api<{ token: string }>('/api/auth/verify', { method: 'POST', body: { message, signature } });
  try {
    localStorage.setItem(tokenKey(address), token);
  } catch {
    /* storage unavailable: the token lives only in memory */
  }
  return token;
}

export async function watchAsset(t: TokenInfo): Promise<boolean> {
  if (!t.address) return false;
  return (await provider().request({
    method: 'wallet_watchAsset',
    params: { type: 'ERC20', options: { address: t.address, symbol: t.symbol, decimals: t.decimals } },
  } as never)) as boolean;
}

const erc20Transfer = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export async function sendToken(cfg: ChainConfig, from: Address, token: TokenInfo, to: string, amount: string) {
  if (!token.address) throw new Error('Токен ещё не создан');
  const value = parseUnits(amount.replace(',', '.').trim(), token.decimals);
  await ensureChain(cfg);
  const client = createWalletClient({ chain: toChain(cfg), transport: custom(provider()) });
  return client.writeContract({
    account: from,
    address: token.address,
    abi: erc20Transfer,
    functionName: 'transfer',
    args: [getAddress(to), value],
  });
}

export function onAccountsChanged(cb: (accounts: string[]) => void): () => void {
  const p = getProvider();
  if (!p?.on) return () => {};
  const h = (a: string[]) => cb(a);
  p.on('accountsChanged', h);
  return () => p.removeListener?.('accountsChanged', h);
}

export function walletErrorText(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err.code === 4001 || /rejected|denied/i.test(err.message ?? '')) return 'Действие отменено в кошельке';
  if (/TransferNotAllowed/.test(err.message ?? '')) return 'Этот адрес не участвует в вашей партии, или партия уже остановлена';
  if (/InsufficientBalance/.test(err.message ?? '')) return 'Недостаточно токенов';
  if (/insufficient funds/i.test(err.message ?? '')) return 'Не хватает CPL на оплату газа. Попросите ведущего досыпать газ';
  return err.shortMessage ?? err.message ?? 'Неизвестная ошибка';
}
