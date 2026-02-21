// Compatibility shim: old import path (`./order-builder/gabagool`) now re-exports copytrade bot.
export { CopytradeArbBot as GabagoolArbBot, copytrade as gabagool } from "./copytrade";