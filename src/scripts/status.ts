import { getAllowance } from "../agent/wallet.js";

const s = await getAllowance();
console.log(JSON.stringify(s, null, 2));
