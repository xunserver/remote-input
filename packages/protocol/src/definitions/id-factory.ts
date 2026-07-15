/** 创建在当前语义域内非空且唯一的关联标识符；不承诺可用于安全认证。 */
export type IdFactory = () => string;
