// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {BondedVault} from "../BondedVault.sol";

/// Test only (test 21). A six-decimal token that, when armed, calls back into the vault's `claim`
/// from inside its own `transfer` — the moment the vault pays it. It also stands in as a depositor,
/// so the re-entrant `claim` is for the very account being paid. The vault's guard must stop it
/// being paid twice. Only `transfer` (the vault's push) re-enters; `transferFrom` (the vault's
/// pull) does not, so deposits and the bond are unaffected.
contract ReentrantUSDC is ERC20 {
    BondedVault public vault;
    bool public armed;
    uint256 public reentries;
    bytes public lastReason; // what the vault answered the last call back with

    constructor() ERC20("Reentrant Dollar", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setVault(BondedVault v) external {
        vault = v;
    }

    function arm(bool on) external {
        armed = on;
    }

    function doDeposit(uint256 amount) external {
        _approve(address(this), address(vault), amount);
        vault.deposit(amount);
    }

    function doRequest(uint256 shares) external {
        vault.requestWithdraw(shares);
    }

    function doClaim() external {
        vault.claim();
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed && address(vault) != address(0)) {
            reentries++;
            // A second claim for this same account. The vault refuses it; the reason is kept so
            // that a test can tell the guard's refusal from the vault's own "nothing to pay".
            try vault.claim() {
                delete lastReason;
            } catch (bytes memory reason) {
                lastReason = reason;
            }
        }
        return super.transfer(to, amount);
    }
}
