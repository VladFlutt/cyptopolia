/**
 * End-to-end check of a whole game in a real browser.
 * A test wallet is injected as window.ethereum (EIP-1193): it signs with a local key, the way MetaMask would.
 *
 * Needs: anvil in PATH (or ANVIL_BIN), Playwright with Chromium, `npm run build` done in web/.
 * Run from the repo root: node web/e2e/game.mjs [screenshots-dir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium, devices } = require('playwright');
const viem = await import(resolve(root, 'backend/node_modules/viem/_esm/index.js'));
const accounts = await import(resolve(root, 'backend/node_modules/viem/_esm/accounts/index.js'));

const shots = resolve(process.argv[2] ?? resolve(root, 'web/e2e/screenshots'));
mkdirSync(shots, { recursive: true });

const CHAIN_ID = 7707007;
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* not ready */
    }
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const chainPort = await freePort();
const appPort = await freePort();
const rpcUrl = `http://127.0.0.1:${chainPort}`;
const base = `http://127.0.0.1:${appPort}`;
const procs = [];

try {
  procs.push(
    spawn(process.env.ANVIL_BIN ?? 'anvil', ['--port', String(chainPort), '--chain-id', String(CHAIN_ID), '--silent'], {
      stdio: 'ignore',
    }),
  );
  const probe = viem.createPublicClient({ transport: viem.http(rpcUrl) });
  await waitFor(() => probe.getBlockNumber().then(() => true), 'anvil');

  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(root, 'backend'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      RPC_URL: rpcUrl,
      PUBLIC_URL: base,
      CHAIN_ID: String(CHAIN_ID),
      OPERATOR_KEY,
      BANK_MNEMONIC: accounts.generateMnemonic(accounts.english),
      DB_PATH: ':memory:',
      WEB_DIST: resolve(root, 'web/dist'),
      INDEXER_POLL_MS: '300',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(backend);
  await waitFor(() => fetch(`${base}/api/health`).then((r) => r.ok), 'backend');

  const chain = viem.defineChain({
    id: CHAIN_ID,
    name: 'Cryptopolia',
    nativeCurrency: { name: 'CPL', symbol: 'CPL', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const browser = await chromium.launch();

  /** A browser context with an injected test wallet. */
  async function walletContext(name, opts = {}) {
    const account = accounts.privateKeyToAccount(accounts.generatePrivateKey());
    const wallet = viem.createWalletClient({ chain, transport: viem.http(rpcUrl), account });
    const ctx = await browser.newContext(opts);
    let chainId = 1; // starts on "Ethereum": the page must add and switch to the game network
    const known = new Set([1]);
    await ctx.exposeFunction('__wallet', async (method, params) => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address];
        case 'eth_chainId':
          return `0x${chainId.toString(16)}`;
        case 'wallet_switchEthereumChain': {
          const id = parseInt(params[0].chainId, 16);
          if (!known.has(id)) throw { code: 4902, message: 'Unrecognized chain' };
          chainId = id;
          return null;
        }
        case 'wallet_addEthereumChain':
          known.add(parseInt(params[0].chainId, 16));
          chainId = parseInt(params[0].chainId, 16);
          return null;
        case 'wallet_watchAsset':
          return true;
        case 'personal_sign':
          return account.signMessage({ message: { raw: params[0] } });
        case 'eth_sendTransaction': {
          const tx = params[0];
          return wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        default: {
          const res = await fetch(`${base}/rpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const j = await res.json();
          if (j.error) throw j.error;
          return j.result;
        }
      }
    });
    await ctx.addInitScript(() => {
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          try {
            return await window.__wallet(method, params ?? []);
          } catch (e) {
            const err = new Error(e?.message ?? String(e));
            err.code = e?.code;
            throw err;
          }
        },
        on() {},
        removeListener() {},
      };
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[${name}] page error:`, e.message));
    page.on('dialog', (d) => d.accept());
    return { page, account };
  }

  const step = (t) => console.log(`• ${t}`);
  const shot = (page, file) => page.screenshot({ path: resolve(shots, file), fullPage: true });

  // ---- host
  const host = await walletContext('host', { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  await host.page.goto(`${base}/admin`);
  await host.page.getByRole('button', { name: 'Войти через кошелёк' }).click();
  await host.page.getByRole('heading', { name: 'Мои партии' }).waitFor();
  step('host signed in with the wallet');
  await host.page.getByLabel('Название').fill('Группа ЭК-21');
  await host.page.getByLabel('Игроков').selectOption('3');
  await host.page.getByRole('button', { name: 'Создать партию' }).click();
  await host.page.getByText('Подключение игроков').waitFor();
  const code = (await host.page.locator('.join-code strong').innerText()).trim();
  step(`session created, code ${code}`);
  await shot(host.page, '1-admin-new-session.png');

  // ---- a phone without a wallet: shows "open in wallet" links
  const plain = await browser.newContext({ ...devices['iPhone 13'] });
  const plainPage = await plain.newPage();
  await plainPage.goto(`${base}/j/${code}`);
  await plainPage.getByText('Откройте страницу в кошельке').waitFor();
  await shot(plainPage, '2-player-no-wallet.png');
  step('phone without a wallet sees wallet deep links');

  // ---- players
  const players = [];
  for (const name of ['Алиса', 'Борис']) {
    const p = await walletContext(name, { ...devices['iPhone 13'] });
    await p.page.goto(`${base}/j/${code}`);
    await p.page.getByRole('button', { name: 'Подключить кошелёк' }).click();
    await p.page.getByLabel('Ваше имя в игре').fill(name);
    await p.page.getByRole('button', { name: 'Войти в партию' }).click();
    await p.page.getByRole('heading', { name: 'Мой портфель' }).waitFor({ timeout: 20000 });
    await p.page.getByText('1 500 USDG').first().waitFor();
    players.push({ name, ...p });
    step(`${name} connected, added the network, signed in and joined`);
  }
  const [alice, boris] = players;

  // ---- Alice pays Boris from her wallet
  await alice.page.getByLabel('Кому').selectOption({ label: 'Борис' });
  await alice.page.getByLabel('Сумма').fill('200');
  await alice.page.getByRole('button', { name: 'Отправить' }).click();
  await alice.page.getByText('Отправлено').waitFor();
  await alice.page.getByText('1 300 USDG').waitFor({ timeout: 15000 });
  step('Alice sent 200 USDG to Boris');

  // ---- host: salary to all, BTK to Alice, new BTK price
  await host.page.getByRole('button', { name: 'Отправить' }).click();
  await host.page.getByText('Банк перевёл 200 USDG → всем игрокам').waitFor({ timeout: 20000 });
  await host.page.getByLabel('Кому').selectOption({ label: 'Алиса' });
  await host.page.getByLabel('Токен').selectOption('BTK');
  await host.page.getByLabel('Сумма').fill('0,005');
  await host.page.getByRole('button', { name: 'Отправить' }).click();
  await host.page.getByText('Банк перевёл 0,005 BTK → Алиса').waitFor({ timeout: 20000 });
  await host.page.getByLabel('Цена BTK').fill('120000');
  await host.page.getByRole('button', { name: 'Сохранить курсы' }).click();
  await host.page.getByText('Курсы обновлены').waitFor();
  step('host paid salary and BTK from the bank and raised the BTK price');

  // Alice: 1300 + 200 = 1500 USDG + 0.005 BTK * 120000 = 600 -> 2100; Boris: 1700 + 200 = 1900
  await host.page.locator('td.num.strong', { hasText: '2 100' }).waitFor({ timeout: 15000 });
  await host.page.getByRole('cell', { name: 'Выпуск' }).first().waitFor();
  await shot(host.page, '3-admin-game-running.png');
  await alice.page.getByText('2 100 USDG').waitFor({ timeout: 15000 });
  await shot(alice.page, '4-player-portfolio.png');
  step('ranking and portfolios show the new values');

  // ---- stop
  await host.page.getByRole('button', { name: 'Остановить партию' }).click();
  await host.page.getByRole('heading', { name: 'Итоги партии' }).waitFor({ timeout: 20000 });
  await shot(host.page, '5-admin-results.png');
  await boris.page.reload();
  await boris.page.getByText('Партия завершена').waitFor();
  await shot(boris.page, '6-player-results.png');
  step('host stopped the game; players see the results');

  await browser.close();
  console.log(`OK. Screenshots: ${shots}`);
} finally {
  for (const p of procs) p.kill();
}
