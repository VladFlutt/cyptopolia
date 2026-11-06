# Криптополия

Развивающая экономическая игра по мотивам «Монополии». Партия идёт на бумажном поле, а расчёты проходят в игровой блокчейн-сети: игроки платят друг другу и банку из своих настоящих криптокошельков (MetaMask, Trust, OKX и другие) и учатся пользоваться реальными инструментами.

## Как устроено

- **Сеть.** Одна EVM-сеть на сервере (chainId 7707007, блок каждые 2 секунды). На ней одновременно идут до 1000 партий.
- **Токены.** В каждой партии 8 токенов: BTK, ETR, BNC, SLN, XRL, MNR, DAX и USDG. Их цены соотносятся примерно как у реальных BTC, ETH, BNB, SOL, XRP, XMR, DAI и USDT. Токены одной партии — дешёвые клоны одного контракта (EIP-1167). Перевести их можно только участникам этой партии и её банку.
- **Ведущий.** Входит своим кошельком (подписью вместо пароля), создаёт партию и управляет только своими партиями: выплаты из банка, курсы, газ, остановка и итоговый рейтинг.
- **Игрок.** Сканирует QR-код партии, подключает кошелёк и получает стартовые 1 500 USDG и немного CPL на газ.

Подробно: [документ с архитектурой](https://claude.ai/artifact/HLi98sSu24MZpyAdXyzEjK).

## Состав репозитория

| Папка | Что внутри |
| --- | --- |
| `contracts/` | Solidity: `GameToken` (ERC-20 для клонов) и `SessionManager` (фабрика партий). Тесты на Foundry |
| `backend/` | TypeScript, Fastify, viem, SQLite: API, вход по подписи, банк, индексатор переводов, публичный RPC-шлюз |
| `deploy/` | Docker Compose, Caddy и [инструкция для Hetzner и российского хостинга](deploy/README.md) |

Админка и страница игрока появятся в шаге 3.

## Разработка

Нужны Node.js 22 и [Foundry](https://getfoundry.sh).

```bash
# Контракты
cd contracts
npm ci                    # OpenZeppelin
forge install             # forge-std для тестов
forge test

# Бэкенд: интеграционные тесты сами поднимают anvil
cd ../backend
npm ci
npm test
npm run typecheck

# После изменения контрактов обновите артефакт для бэкенда
npm run sync-artifacts
```

Запуск бэкенда локально:

```bash
anvil --chain-id 7707007 --block-time 2 &
cd backend
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
BANK_MNEMONIC="test test test test test test test test test test test junk" \
CHAIN_ID=7707007 npm run dev
```

## API

| Метод | Путь | Кто | Что делает |
| --- | --- | --- | --- |
| GET | `/api/config` | все | Параметры сети для `wallet_addEthereumChain` |
| POST | `/api/auth/nonce` | все | Одноразовый код для входа |
| POST | `/api/auth/verify` | все | Проверяет подпись SIWE и выдаёт токен |
| GET | `/api/sessions` | ведущий | Свои партии (суперадмин видит все) |
| POST | `/api/sessions` | ведущий | Создать партию: `{title, maxPlayers, startBalance}` |
| GET | `/api/sessions/:id` | ведущий | Игроки, живой рейтинг, переводы |
| POST | `/api/sessions/:id/pay` | ведущий | Выплата из банка: `{to: адрес или "all", token, amount}` |
| POST | `/api/sessions/:id/gas` | ведущий | Досыпать газ игроку: `{to}` |
| PUT | `/api/sessions/:id/prices` | ведущий | Поменять курсы: `{BTK: 120000}` |
| POST | `/api/sessions/:id/stop` | ведущий | Остановить партию, заморозить токены, посчитать рейтинг |
| GET | `/api/sessions/:id/events` | ведущий | Живая лента переводов (Server-Sent Events) |
| GET | `/api/join/:code` | все | Публичная информация о партии |
| POST | `/api/join/:code` | игрок | Войти в партию: `{name}` |
| GET | `/api/join/:code/me` | игрок | Свои балансы и переводы |
| POST | `/rpc` | кошельки | Публичный JSON-RPC сети с кэшем и белым списком методов |
