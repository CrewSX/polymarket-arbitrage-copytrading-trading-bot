// Compatibility shim: old import path (`./order-builder/gabagool`) now re-exports copytrade bot.
<<<<<<< HEAD
export { CopytradeArbBot as GabagoolArbBot } from "./copytrade";
=======
export { CopytradeArbBot as GabagoolArbBot, copytrade as gabagool } from "./copytrade";
>>>>>>> b06bc1d94962e66b91c3b33349e50f31e96fcb10
