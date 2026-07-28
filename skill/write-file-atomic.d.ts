// write-file-atomic v7 类型声明（v7 不自带类型，@types 版本滞后）。
// v7 ESM default 是 function，且挂 .sync（已验证）。inline `declare module` 对 untyped module 不允许，
// 必须外置 .d.ts。tsconfig 的 include:"*.ts" 不含 .d.ts，但 TS 默认会自动 include 同目录 .d.ts。
declare module "write-file-atomic" {
  export function sync(filename: string, data: string | Buffer, options?: Record<string, unknown>): void;
  const _default: { sync: typeof sync };
  export default _default;
}
