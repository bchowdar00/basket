// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BondedVault
/// @notice A vault that holds depositors' USDC in shares, lets one operator draw a bounded part of
/// it for one epoch at a time against a first-loss bond, and settles each epoch purely from the
/// dollars that come back. The contract never reads its own token balance to decide anything, so
/// USDC sent here by mistake changes nothing. It cannot see the exchange the operator quotes on;
/// everything it enforces is the shares, the bond, the draw limit, the dollar accounting, and the
/// deadline. Nothing about any market, price or order is stored here.
///
/// Virtual shares and assets: every conversion between dollars and shares is priced at
/// (assets + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES), as if 1e6 share units and one USDC
/// unit were owned by nobody. Because the denominator never collapses, lifting the price is dear:
/// anyone who lifts it with a gain they pay themselves gives the virtual shares their part of that
/// gain, and the part is largest when the lifter holds the fewest shares, which is when the lift
/// goes furthest. That money stays in the vault and no depositor can withdraw it. The operator
/// can take it back over
/// later epochs, a draw less its bond at a time, as it can take any depositors' money; so the
/// pair's cost is not final. What a newcomer can lose to rounding is bounded all the same: less
/// than the price of one share unit when the deposit is turned into shares, and one USDC unit more
/// when the shares are paid out. For a deposit made while an epoch is open that moment is the
/// epoch's close, not the moment it was sent, and a waiting deposit smaller than one share unit's
/// price at the close is credited no shares and is lost whole. At par one share unit is a
/// millionth of a USDC unit; in test G5 it takes a 1,000,000-dollar gain to make it worth about a
/// quarter of a dollar. The conversions go through `Math.mulDiv`, and no epoch starts once one
/// USDC unit buys more than MAX_SHARES_PER_UNIT share units, so none can overflow. The two
/// internal pure functions below are the only place a conversion is written.
///
/// Units: USDC has six decimals and every amount is in its smallest unit. Shares carry twelve
/// decimals and are not a token: they are a plain number here, not transferable. An empty vault
/// mints `amount * 1e6` share units for `amount` USDC units, so one whole dollar (1e6 units) buys
/// 1e12 share units at the start. Every division rounds down, and against whoever is paid or
/// credited; what rounding leaves behind stays in the contract and belongs to nobody.
contract BondedVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant VIRTUAL_SHARES = 1e6; // share units that belong to nobody
    uint256 private constant VIRTUAL_ASSETS = 1; // one unit of USDC that belongs to nobody

    /// The most share units one USDC unit may buy when an epoch starts: 1e12 times par (par is 1e6
    /// share units per unit). Below that price the vault takes no new epoch; everyone can still
    /// withdraw what is there. The floor bounds the price so no conversion can overflow — see the
    /// size argument above `_endEpoch`.
    uint256 private constant MAX_SHARES_PER_UNIT = 1e18;

    /// Shares bought by `amount` at a state of `a` assets and `s` shares. Rounds down, against the
    /// buyer. `mulDiv` forms the product in 512 bits, so it cannot overflow; it reverts only if the
    /// result itself does not fit a uint256.
    function _toShares(uint256 amount, uint256 a, uint256 s) private pure returns (uint256) {
        return Math.mulDiv(amount, s + VIRTUAL_SHARES, a + VIRTUAL_ASSETS);
    }

    /// Dollars paid for `shares` at a state of `a` assets and `s` shares. Rounds down, against the
    /// seller. `mulDiv` cannot overflow; and the result is at most `a + 1` whenever `shares <= s`, so
    /// it always fits.
    function _toAssets(uint256 shares, uint256 a, uint256 s) private pure returns (uint256) {
        return Math.mulDiv(shares, a + VIRTUAL_ASSETS, s + VIRTUAL_SHARES);
    }

    struct Close {
        uint256 assets; // the vault's assets at the epoch's end, before withdrawals and waiting deposits
        uint256 shares; // totalShares at the epoch's end, before them — together, the epoch's price
        bool byDefault;
    }

    struct Waiting {
        uint256 amount; // a deposit made while an epoch was open
        uint256 epoch; // that epoch's number
    }

    struct Asked {
        uint256 shares; // a withdrawal asked while an epoch was open
        uint256 epoch; // that epoch's number
    }

    IERC20 public immutable usdc;
    address public immutable operator;
    uint8 public immutable drawBondHalves;
    uint16 public immutable drawVaultBps;
    uint16 public immutable gainBps;
    uint32 public immutable epochSeconds;
    uint256 public immutable capPerMarket;
    uint256 public immutable depositCap;

    uint256 public bond;
    uint256 public assets;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    uint256 public epochId;
    bool public open;
    bool public defaulted;

    bytes32 public plan;
    uint256 public drawn;
    uint64 public deadline;

    mapping(uint256 => Close) public closes;

    mapping(address => Waiting) public waitingOf;
    uint256 public totalWaiting;

    mapping(address => Asked) public askedOf;
    uint256 public askedShares;

    uint256 public setAside;

    bytes32 public head;
    uint256 public commits;

    error BadSetting();
    error NotOperator();
    error EpochOpen();
    error NoEpoch();
    error Defaulted();
    error Nothing();
    error OverLimit();
    error OverCap();
    error NotYet();
    error NotEnough();
    error PriceTooLow();

    event BondPosted(uint256 amount, uint256 bond);
    event BondWithdrawn(uint256 amount, uint256 bond);
    event Deposited(address indexed who, uint256 amount, uint256 minted, uint256 waitingEpoch);
    event Withdrawn(address indexed who, uint256 shares, uint256 paid);
    event WithdrawAsked(address indexed who, uint256 shares, uint256 epochId);
    event Claimed(address indexed who, uint256 paid);
    event EpochStarted(uint256 indexed epochId, bytes32 plan, uint256 draw, uint64 deadline, uint256 bond, uint256 assets);
    event EpochClosed(uint256 indexed epochId, uint256 drawn, uint256 returned, uint256 fee, uint256 fromBond, uint256 assets, uint256 totalShares);
    event DefaultDeclared(uint256 indexed epochId, address indexed by, uint256 drawn, uint256 moved, uint256 assets, uint256 totalShares);
    event Committed(uint256 indexed epochId, bytes32 hash, uint256 commits);

    constructor(
        IERC20 usdc_,
        address operator_,
        uint8 drawBondHalves_,
        uint16 drawVaultBps_,
        uint16 gainBps_,
        uint32 epochSeconds_,
        uint256 capPerMarket_,
        uint256 depositCap_
    ) {
        if (address(usdc_) == address(0)) revert BadSetting();
        if (operator_ == address(0)) revert BadSetting();
        if (drawBondHalves_ < 1 || drawBondHalves_ > 4) revert BadSetting();
        if (drawVaultBps_ < 1 || drawVaultBps_ > 9999) revert BadSetting();
        if (gainBps_ > 10000) revert BadSetting();
        if (epochSeconds_ == 0) revert BadSetting();
        if (depositCap_ == 0) revert BadSetting();
        if (depositCap_ > type(uint96).max) revert BadSetting(); // keeps the floor's size argument sound
        usdc = usdc_;
        operator = operator_;
        drawBondHalves = drawBondHalves_;
        drawVaultBps = drawVaultBps_;
        gainBps = gainBps_;
        epochSeconds = epochSeconds_;
        capPerMarket = capPerMarket_;
        depositCap = depositCap_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // --- the bond --------------------------------------------------------

    function postBond(uint256 amount) external nonReentrant onlyOperator {
        if (defaulted) revert Defaulted();
        if (amount == 0) revert Nothing();
        usdc.safeTransferFrom(operator, address(this), amount);
        bond += amount;
        emit BondPosted(amount, bond);
    }

    function withdrawBond(uint256 amount) external nonReentrant onlyOperator {
        if (open) revert EpochOpen();
        if (defaulted) revert Defaulted();
        if (amount == 0) revert Nothing();
        if (amount > bond) revert NotEnough();
        bond -= amount;
        usdc.safeTransfer(operator, amount);
        emit BondWithdrawn(amount, bond);
    }

    // --- depositors ------------------------------------------------------

    function deposit(uint256 amount) external nonReentrant {
        if (defaulted) revert Defaulted();
        if (amount == 0) revert Nothing();
        // The cap is on what depositors have put in, what is waiting, and what is out with the
        // operator: `drawn` leaves `assets` while an epoch is open, so it is added back here (and in
        // room()) or the cap would have that much more room until the epoch closed. A gain that lifts
        // `assets` past the cap stops new deposits and nothing else.
        if (assets + totalWaiting + (open ? drawn : 0) + amount > depositCap) revert OverCap();
        _settle(msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 minted = 0;
        uint256 waitingEpoch = 0;
        if (!open) {
            // shares bought at the virtual-share price; an empty vault mints amount * 1e6
            minted = _toShares(amount, assets, totalShares);
            if (minted == 0) revert Nothing();
            assets += amount;
            totalShares += minted;
            sharesOf[msg.sender] += minted;
        } else {
            waitingOf[msg.sender].amount += amount;
            waitingOf[msg.sender].epoch = epochId;
            totalWaiting += amount;
            waitingEpoch = epochId;
        }
        emit Deposited(msg.sender, amount, minted, waitingEpoch);
    }

    function requestWithdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert Nothing();
        _settle(msg.sender);
        _collect(msg.sender); // pay anything already claimable, as claim() does
        if (sharesOf[msg.sender] < shares) revert NotEnough();

        if (!open) {
            // no epoch open (also after a default): pay at once at the virtual-share price
            uint256 paid = _toAssets(shares, assets, totalShares);
            sharesOf[msg.sender] -= shares;
            totalShares -= shares;
            assets -= paid;
            usdc.safeTransfer(msg.sender, paid);
            emit Withdrawn(msg.sender, shares, paid);
        } else {
            // the shares stay in totalShares until the epoch ends, so they share its result
            sharesOf[msg.sender] -= shares;
            askedOf[msg.sender].shares += shares;
            askedOf[msg.sender].epoch = epochId;
            askedShares += shares;
            emit WithdrawAsked(msg.sender, shares, epochId);
        }
    }

    function claim() external nonReentrant {
        _settle(msg.sender);
        uint256 paid = _collect(msg.sender);
        if (paid == 0) revert Nothing();
        emit Claimed(msg.sender, paid);
    }

    // --- the operator's epoch -------------------------------------------

    function startEpoch(bytes32 plan_, uint256 draw) external nonReentrant onlyOperator {
        if (open) revert EpochOpen();
        if (defaulted) revert Defaulted();
        if (draw == 0) revert Nothing();
        // at most a multiple of the bond and at most a part of the depositors' assets
        if (draw > (bond * drawBondHalves) / 2 || draw > (assets * drawVaultBps) / 10000) revert OverLimit();
        // the price floor: one USDC unit may buy at most MAX_SHARES_PER_UNIT share units at a start,
        // so no conversion this epoch can overflow (see the size argument above `_endEpoch`)
        if (totalShares + VIRTUAL_SHARES > MAX_SHARES_PER_UNIT * (assets + VIRTUAL_ASSETS)) revert PriceTooLow();
        epochId += 1;
        open = true;
        plan = plan_;
        drawn = draw;
        deadline = uint64(block.timestamp) + epochSeconds;
        assets -= draw;
        usdc.safeTransfer(operator, draw);
        emit EpochStarted(epochId, plan_, draw, deadline, bond, assets);
    }

    function closeEpoch(uint256 returned) external nonReentrant onlyOperator {
        if (!open) revert NoEpoch();
        // Allowed after the deadline for as long as nobody has declared a default (ruling 1):
        // once a default is declared `open` is false, so this reverts NoEpoch.
        usdc.safeTransferFrom(operator, address(this), returned);

        uint256 fee = 0;
        uint256 fromBond = 0;
        if (returned >= drawn) {
            uint256 gain = returned - drawn;
            fee = (gain * gainBps) / 10000; // the operator's share rounds down
            assets += drawn + gain - fee;
        } else {
            uint256 loss = drawn - returned;
            fromBond = loss < bond ? loss : bond; // a loss is taken from the bond first
            bond -= fromBond;
            assets += returned + fromBond;
        }

        uint256 e = epochId;
        _endEpoch(false);
        if (fee > 0) usdc.safeTransfer(operator, fee);
        emit EpochClosed(e, drawn, returned, fee, fromBond, closes[e].assets, closes[e].shares);
    }

    function declareDefault() external {
        if (!open) revert NoEpoch();
        if (block.timestamp <= deadline) revert NotYet();
        uint256 moved = bond; // the whole bond, even where it is more than was drawn
        defaulted = true;
        assets += moved;
        bond = 0;
        uint256 e = epochId;
        _endEpoch(true); // nothing comes back for `drawn`
        emit DefaultDeclared(e, msg.sender, drawn, moved, closes[e].assets, closes[e].shares);
    }

    function commit(bytes32 hash) external onlyOperator {
        head = hash;
        commits += 1;
        emit Committed(epochId, hash, commits);
    }

    // --- internals -------------------------------------------------------

    /// Ends the open epoch. Neither division below can be by zero: each divisor carries a virtual
    /// part (totalShares + VIRTUAL_SHARES, closes[e].assets + VIRTUAL_ASSETS), both non-zero at every
    /// state. And `assets -= out` cannot underflow: out = _toAssets(askedShares, assets, totalShares)
    /// with askedShares <= totalShares, and since askedShares < totalShares + VIRTUAL_SHARES the
    /// quotient is strictly below assets + VIRTUAL_ASSETS, so out <= assets.
    ///
    /// Why no conversion can overflow (with the start-time floor and depositCap <= 2^96):
    /// - Write r = (totalShares + VIRTUAL_SHARES) / (assets + VIRTUAL_ASSETS). A start needs r <= 1e18.
    /// - A draw is at most assets * drawVaultBps / 10000 with drawVaultBps <= 9999, so it leaves at
    ///   least assets/10000, and the close only adds dollars back; so the recorded close assets are at
    ///   least the start's assets / 10000, totalShares is unchanged, and r at the close is below 1e22.
    ///   (The bond is at least half of any draw and cannot leave while an epoch is open, so a close
    ///   in fact leaves at least half the assets and r at most doubles; the looser bound is all this
    ///   argument needs.) Shares asked out, a withdrawal, a deposit, a gain and a default never raise r.
    /// - totalWaiting <= depositCap <= 2^96, so the shares minted here are below 2^96 * 1e22, far
    ///   inside a uint256; totalShares + VIRTUAL_SHARES is never more than 1e22 * (assets + 1), and
    ///   assets is a count of USDC units that exist. _toAssets returns at most assets + 1.
    /// - The floor's own product, MAX_SHARES_PER_UNIT * (assets + 1), fits while assets are under
    ///   about 1e59 units, far past any supply of USDC. With a token that could be minted past that,
    ///   startEpoch would fail and nothing else: withdrawals and the bond would still leave.
    /// - So no conversion in _endEpoch, _settle, _collect, owed, deposit or requestWithdraw can revert
    ///   for size, and an open epoch can always be closed or defaulted.
    function _endEpoch(bool byDefault) internal {
        uint256 e = epochId;
        closes[e] = Close(assets, totalShares, byDefault);

        // asked withdrawals leave at the epoch's price, as one sum
        if (askedShares > 0) {
            uint256 out = _toAssets(askedShares, assets, totalShares); // closes[e].assets / closes[e].shares
            assets -= out;
            totalShares -= askedShares;
            setAside += out;
            askedShares = 0;
        }

        // waiting deposits come in at the epoch's price, as one sum — but not on a default,
        // where nothing moves and each deposit is claimed back whole
        if (!byDefault && totalWaiting > 0) {
            uint256 minted = _toShares(totalWaiting, closes[e].assets, closes[e].shares);
            assets += totalWaiting;
            totalShares += minted;
            totalWaiting = 0;
        }

        open = false;
    }

    /// Credits a caller's waiting deposit, once its epoch has ended and did not end by default, at
    /// that epoch's price. The sum of what depositors are credited is never more than what the
    /// epoch's end minted; the difference is nobody's.
    function _settle(address who) internal {
        Waiting storage wdep = waitingOf[who];
        uint256 amt = wdep.amount;
        if (amt == 0) return;
        uint256 e = wdep.epoch;
        if (e == epochId && open) return; // still waiting in the open epoch
        if (!closes[e].byDefault) {
            sharesOf[who] += _toShares(amt, closes[e].assets, closes[e].shares);
            delete waitingOf[who];
        }
        // on a default the deposit stays for claim() to return whole
    }

    /// Pays everything `who` is owed from ended epochs: an asked withdrawal at the epoch's price
    /// (from setAside), and a deposit that waited in an epoch that ended by default, back whole
    /// (from totalWaiting). Clears both records. Returns what was paid; does not revert when nothing
    /// is owed.
    function _collect(address who) internal returns (uint256 paid) {
        Asked storage a = askedOf[who];
        if (a.shares > 0) {
            uint256 e = a.epoch;
            if (!(e == epochId && open)) {
                uint256 amt = _toAssets(a.shares, closes[e].assets, closes[e].shares);
                delete askedOf[who];
                setAside -= amt;
                paid += amt;
            }
        }

        Waiting storage wdep = waitingOf[who];
        if (wdep.amount > 0) {
            uint256 e = wdep.epoch;
            if (!(e == epochId && open) && closes[e].byDefault) {
                uint256 amt = wdep.amount;
                delete waitingOf[who];
                totalWaiting -= amt;
                paid += amt;
            }
        }

        if (paid > 0) usdc.safeTransfer(who, paid);
    }

    // --- views -----------------------------------------------------------

    /// Dollars (scaled by 1e18) for one whole share — 1e12 share units — at the virtual-share price.
    /// It is 1e18 for a vault that has never held a deposit and for a vault at par; a used vault that
    /// is empty again reads what was left behind (so it need not be 1e18). `mulDiv` keeps the
    /// scaled product from overflowing.
    function sharePrice() external view returns (uint256) {
        return Math.mulDiv(assets + VIRTUAL_ASSETS, 1e18 * VIRTUAL_SHARES, totalShares + VIRTUAL_SHARES);
    }

    function limits() external view returns (uint256 byBond, uint256 byVault, uint256 maxDraw) {
        byBond = (bond * drawBondHalves) / 2;
        byVault = (assets * drawVaultBps) / 10000;
        maxDraw = byBond < byVault ? byBond : byVault;
    }

    function room() external view returns (uint256) {
        if (defaulted) return 0;
        uint256 used = assets + totalWaiting + (open ? drawn : 0);
        return used >= depositCap ? 0 : depositCap - used;
    }

    function epoch() external view returns (uint256 id, bool isOpen, bool isDefaulted, bytes32 plan_, uint256 drawn_, uint64 deadline_) {
        return (epochId, open, defaulted, plan, drawn, deadline);
    }

    /// The caller's shares as they would stand after settling, what claim() would pay now, and a
    /// deposit still waiting in the open epoch.
    function owed(address who) external view returns (uint256 shares, uint256 claimable, uint256 waiting) {
        shares = sharesOf[who];

        Waiting storage wdep = waitingOf[who];
        if (wdep.amount > 0) {
            uint256 e = wdep.epoch;
            if (e == epochId && open) {
                waiting = wdep.amount;
            } else if (closes[e].byDefault) {
                claimable += wdep.amount;
            } else {
                shares += _toShares(wdep.amount, closes[e].assets, closes[e].shares);
            }
        }

        Asked storage a = askedOf[who];
        if (a.shares > 0) {
            uint256 e = a.epoch;
            if (!(e == epochId && open)) {
                claimable += _toAssets(a.shares, closes[e].assets, closes[e].shares);
            }
        }
    }
}
