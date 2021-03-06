// SPDX-License-Identifier: MIT

pragma solidity ^0.6.9;

interface PtdBank {
    function deposit(address token, uint256 amount) external payable;

    function withdraw(address token, uint256 pAmount) external;

    function banks(address token)
        external
        view
        returns (
            address tokenAddr,
            address pTokenAddr,
            bool isOpen,
            bool canDeposit,
            bool canWithdraw,
            uint256 totalVal,
            uint256 totalDebt,
            uint256 totalDebtShare,
            uint256 totalReserve,
            uint256 lastInterestTime
        );

    function totalToken(address token) external view returns (uint256);
}

interface StakingReward {
    function stake(uint256 amount) external;

    function withdraw(uint256 amount) external;

    function getReward() external;

    function stakingToken() external view returns (address);

    function balanceOf(address account) external view returns (uint256);

    function earned(address account) external view returns (uint256);
}

import "../../interfaces/IStrategy.sol";
import "./PtdConfig.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

contract PtdStrategy is IStrategy {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    address public ptdBankAddr;
    address private _rewardsToken;
    PtdConfig public ptdConfig;

    address public owner;

    modifier onlyOwner() {
        require(owner == msg.sender, "caller is not the owner");
        _;
    }

    constructor(PtdConfig _ptdConfig, address _owner) public {
        ptdBankAddr = _ptdConfig.ptdBankAddr();
        _rewardsToken = _ptdConfig.rewardsToken();
        ptdConfig = _ptdConfig;
        owner = _owner;
    }

    function rewardsToken() external view override returns (address) {
        return _rewardsToken;
    }

    function deposit(address token, uint256 amount)
        external
        payable
        override
        onlyOwner
    {
        PtdBank ptdBank = PtdBank(ptdBankAddr);
        address stakingPool = getStakingPool(token);

        if (token == address(0)) {
            //HT
            amount = msg.value;
        } else {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            IERC20(token).approve(ptdBankAddr, amount);
        }
        ptdBank.deposit{value: msg.value}(token, amount);

        address pToken = getPtoken(token);
        uint256 pTokenAmount = IERC20(pToken).balanceOf(address(this));

        IERC20(pToken).approve(stakingPool, pTokenAmount);
        StakingReward(stakingPool).stake(pTokenAmount);
    }

    function balanceOf(address token, address account)
        external
        view
        override
        returns (uint256)
    {
        address stakingPool = getStakingPool(token);

        uint256 pTokenBalance = StakingReward(stakingPool).balanceOf(account);
        uint256 totalTokenAmount = PtdBank(ptdBankAddr).totalToken(token);
        address pTokenAddr = getPtoken(token);
        uint256 pTokenTotalSupply = IERC20(pTokenAddr).totalSupply();
        uint256 tokenBalance = pTokenBalance.mul(totalTokenAmount).div(
            pTokenTotalSupply
        );
        return tokenBalance;
    }

    function earned(address token) external view override returns (uint256) {
        address stakingPool = getStakingPool(token);

        return StakingReward(stakingPool).earned(address(this));
    }

    function withdraw(address token, uint256 amount)
        external
        override
        onlyOwner
        returns (uint256)
    {
        uint256 totalTokenAmount = PtdBank(ptdBankAddr).totalToken(token);
        address pTokenAddr = getPtoken(token);
        uint256 pTokenTotalSupply = IERC20(pTokenAddr).totalSupply();
        uint256 pAmount = (totalTokenAmount == 0 || pTokenTotalSupply == 0)
            ? amount
            : amount.mul(pTokenTotalSupply).div(totalTokenAmount);

        address stakingPool = getStakingPool(token);

        StakingReward(stakingPool).withdraw(pAmount);
        PtdBank(ptdBankAddr).withdraw(token, pAmount);
        if (token == address(0)) {
            //HT
            payable(owner).transfer(amount);
            return amount;
        }
        uint256 realAmount = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, realAmount);
        return realAmount;
    }

    function claimRewards(address token) external override onlyOwner {
        address stakingPool = getStakingPool(token);

        StakingReward(stakingPool).getReward();
        uint256 rewardAmount = IERC20(_rewardsToken).balanceOf(address(this));
        IERC20(_rewardsToken).transfer(owner, rewardAmount);
    }

    function isTokenSupported(address token)
        external
        view
        override
        returns (bool)
    {
        bool isOpen;
        bool canDeposit;
        PtdBank ptdBank = PtdBank(ptdBankAddr);
        (, , isOpen, canDeposit, , , , , , ) = ptdBank.banks(token);
        return isOpen && canDeposit;
    }

    function getPtoken(address token) internal view returns (address) {
        PtdBank ptdBank = PtdBank(ptdBankAddr);
        address pToken;
        (, pToken, , , , , , , , ) = ptdBank.banks(token);
        return pToken;
    }

    function getStakingPool(address token) internal view returns (address) {
        address stakingPool = ptdConfig.getStakingPool(token);
        require(stakingPool != address(0), "staking pool is not configured");

        return stakingPool;
    }

    receive() external payable {}
}
