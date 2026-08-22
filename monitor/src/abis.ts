import { parseAbi } from "viem";

// Minimal official EVault surface used by the collector.
export const EVaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function interestRate() view returns (uint256)",
  "function interestRateModel() view returns (address)",
  "function oracle() view returns (address)",
  "function unitOfAccount() view returns (address)",
  "function caps() view returns (uint16 supplyCap, uint16 borrowCap)",
  "function LTVList() view returns (address[])",
  "event Borrow(address indexed account, uint256 assets)",
  "event Repay(address indexed account, uint256 assets)",
  "event InterestAccrued(address indexed account, uint256 assets)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event GovSetInterestRateModel(address newInterestRateModel)",
]);
export const ERC20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const LinearIrmAbi = parseAbi([
  "function name() view returns (string)",
  "function baseRate() view returns (uint256)",
  "function slope1() view returns (uint256)",
  "function slope2() view returns (uint256)",
  "function kink() view returns (uint256)",
]);

export const KinkyIrmAbi = parseAbi([
  "function name() view returns (string)",
  "function baseRate() view returns (uint256)",
  "function slope() view returns (uint256)",
  "function shape() view returns (uint256)",
  "function kink() view returns (uint256)",
  "function cutoff() view returns (uint256)",
]);

export const AdaptiveIrmAbi = parseAbi([
  "function name() view returns (string)",
  "function TARGET_UTILIZATION() view returns (int256)",
  "function INITIAL_RATE_AT_TARGET() view returns (int256)",
  "function MIN_RATE_AT_TARGET() view returns (int256)",
  "function MAX_RATE_AT_TARGET() view returns (int256)",
  "function CURVE_STEEPNESS() view returns (int256)",
  "function ADJUSTMENT_SPEED() view returns (int256)",
]);

export const GenericFactoryAbi = parseAbi([
  "function isProxy(address proxy) view returns (bool)",
]);

export const EulerEarnFactoryAbi = parseAbi([
  "function isVault(address vault) view returns (bool)",
]);

export const IrmLensAbi = parseAbi([
  "function getInterestRateModelInfo(address irm) view returns ((address interestRateModel, uint8 interestRateModelType, bytes interestRateModelParams))",
]);

export const UtilsLensAbi = parseAbi([
  "function getAssetPriceInfo(address asset, address unitOfAccount) view returns ((bool queryFailure, bytes queryFailureReason, uint256 timestamp, address oracle, address asset, address unitOfAccount, uint256 amountIn, uint256 amountOutMid, uint256 amountOutBid, uint256 amountOutAsk))",
  "function getControllerAssetPriceInfo(address controller, address asset) view returns ((bool queryFailure, bytes queryFailureReason, uint256 timestamp, address oracle, address asset, address unitOfAccount, uint256 amountIn, uint256 amountOutMid, uint256 amountOutBid, uint256 amountOutAsk))",
]);
