// Pays for the weather service from the terminal, without Claude. The API server must be running.
// Usage: npm run demo -- [city]
import { API_BASE_URL } from "../lib/config.js";
import { paidFetch } from "./paidFetch.js";
import { getAllowance } from "./wallet.js";

const city = process.argv[2] ?? "Dublin";

const before = await getAllowance();
console.log(`Allowance: ${before.allowanceUsdc} USDC (owner balance ${before.ownerBalanceUsdc} USDC)`);

const result = await paidFetch(`${API_BASE_URL}/api/weather?city=${encodeURIComponent(city)}`);
if (result.payment?.ok) console.log(`Paid ${result.priceUsdc} USDC: ${result.payment.explorer}`);
else if (result.payment) console.log(`BLOCKED: ${result.payment.reason}\n${result.payment.explorer}`);
else if (result.refused) console.log(`Refused: ${result.refused}`);
console.log(`HTTP ${result.status}`, JSON.stringify(result.body, null, 2));

console.log(`Allowance left: ${(await getAllowance()).allowanceUsdc} USDC`);
