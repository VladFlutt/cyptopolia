/**
 * Generates deploy/.env with fresh secrets.
 * Usage: npx tsx scripts/init-env.ts <public-url> [superadmin-address]
 * Example: npx tsx scripts/init-env.ts https://203-0-113-7.sslip.io 0xYourWallet
 */
import { existsSync, writeFileSync } from 'node:fs';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';

const [publicUrl, superadmin = ''] = process.argv.slice(2);
if (!publicUrl?.startsWith('https://')) {
  console.error('Укажите публичный адрес сайта: https://...');
  process.exit(1);
}
const out = new URL('../../deploy/.env', import.meta.url);
if (existsSync(out)) {
  console.error('deploy/.env уже существует, не перезаписываю');
  process.exit(1);
}
const nodeMnemonic = generateMnemonic(english);
const operator = mnemonicToAccount(nodeMnemonic, { addressIndex: 0 });
const operatorKey = bytesToHex(operator.getHdKey().privateKey!);

writeFileSync(
  out,
  [
    `# Сгенерировано ${new Date().toISOString()}. Храните этот файл в секрете.`,
    `PUBLIC_URL=${publicUrl.replace(/\/$/, '')}`,
    `SITE_HOST=${new URL(publicUrl).host}`,
    `CHAIN_ID=7707007`,
    `CHAIN_NAME="Криптополия (игровая)"`,
    `NODE_MNEMONIC="${nodeMnemonic}"`,
    `OPERATOR_KEY=${operatorKey}`,
    `BANK_MNEMONIC="${generateMnemonic(english)}"`,
    `SUPERADMINS=${superadmin}`,
    `MAX_ACTIVE_SESSIONS_PER_HOST=3`,
    `DEFAULT_START_BALANCE=1500`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`Готово: deploy/.env, оператор ${operator.address}`);
