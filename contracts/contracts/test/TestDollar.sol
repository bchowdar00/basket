// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test only. A stand-in for USDC: six decimals, anyone may mint any amount to anyone. It holds no
/// market data and knows nothing of the vault.
contract TestDollar is ERC20 {
    constructor() ERC20("Test Dollar", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
