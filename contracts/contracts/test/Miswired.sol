// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

/// Test only (the deployment script's test). It takes the vault's eight settings and answers the
/// vault's eight getters, but keeps an epoch one second longer than it was given, so that the
/// script's read-back after a deployment has something wrong to find. It has no `decimals`, so it
/// also stands in for an address that is not a six-decimal token.
contract Miswired {
    address public immutable usdc;
    address public immutable operator;
    uint8 public immutable drawBondHalves;
    uint16 public immutable drawVaultBps;
    uint16 public immutable gainBps;
    uint32 public immutable epochSeconds;
    uint256 public immutable capPerMarket;
    uint256 public immutable depositCap;

    constructor(
        address usdc_,
        address operator_,
        uint8 drawBondHalves_,
        uint16 drawVaultBps_,
        uint16 gainBps_,
        uint32 epochSeconds_,
        uint256 capPerMarket_,
        uint256 depositCap_
    ) {
        usdc = usdc_;
        operator = operator_;
        drawBondHalves = drawBondHalves_;
        drawVaultBps = drawVaultBps_;
        gainBps = gainBps_;
        epochSeconds = epochSeconds_ + 1;
        capPerMarket = capPerMarket_;
        depositCap = depositCap_;
    }
}
