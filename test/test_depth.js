const { ethers } = require("hardhat");
const { solidity } = require("ethereum-waffle");
const chai = require("chai");
const BN = require('bn.js');

chai.use(solidity);
chai.use(require('chai-bn')(BN));
const { assert, expect } = chai;

const { impersonateForToken, approve, setNextBlockTimestamp } = require("./helper");
const { husd, usdt } = require("../info/tokens");

const { DEP, piggyBreederAddr, vaults } = require("../info/depth");

// contracts
let globalConfig;
let smartWalletImpl;
let smartWallet;
let smartWalletFactory;
let usdtContract;

let startegyNames = [];
let depthStrategyFactories = [];
let lpTokenToPid = {};

async function deploySmartWallet() {
  console.log("Deploying SmartWallet Contracts");

  const GlobalConfig = await ethers.getContractFactory("GlobalConfig");
  globalConfig = await GlobalConfig.deploy();
  await globalConfig.deployed();

  const SmartWallet = await ethers.getContractFactory("SmartWallet");
  smartWalletImpl = await SmartWallet.deploy();
  await smartWalletImpl.deployed();

  const SmartWalletFactory = await ethers.getContractFactory("SmartWalletFactory");
  smartWalletFactory = await SmartWalletFactory.deploy(smartWalletImpl.address);
  await smartWalletFactory.deployed();
}

async function getDepthInitData() {
  const piggyBreeder = await ethers.getContractAt("IPiggyBreeder", piggyBreederAddr);
  const poolLength = await piggyBreeder.poolLength();
  for (let i = 0; i < poolLength; i++) {
    const pool = await piggyBreeder.poolInfo(i);
    lpTokenToPid[pool["lpToken"]] = i;
  }
}

async function deployDepth() {
  for (let i = 0; i < vaults.length; i++) {
      const startegyName = "Depth-" + vaults[i].name;

      const DepthConfig = await ethers.getContractFactory("DepthConfig");
      const depthConfig = await DepthConfig.deploy(piggyBreederAddr, DEP);
      await depthConfig.deployed();
      console.log(startegyName, "DepthConfig address:", depthConfig.address);

      await depthConfig.setVault(usdt.address, vaults[i]["usdt"], lpTokenToPid[vaults[i]["usdt"]]);
      await depthConfig.setVault(husd.address, vaults[i]["husd"], lpTokenToPid[vaults[i]["husd"]]);

      const DepthStrategyFactory = await ethers.getContractFactory("DepthStrategyFactory");
      const depthStrategyFactory = await DepthStrategyFactory.deploy(depthConfig.address);
      await depthStrategyFactory.deployed();
      console.log(startegyName, "StrategyFactory:", depthStrategyFactory.address);

      await globalConfig.setStrategyFactory(startegyName, depthStrategyFactory.address);
      startegyNames.push(startegyName);
      depthStrategyFactories.push(depthStrategyFactory);
  }
}

describe("Depth", function() {
  let deployer, user;
  let productName;

  before(async function() {
    [deployer, user] = await ethers.getSigners();

    usdtContract = await ethers.getContractAt("IERC20", usdt.address);

    await getDepthInitData();
    await deploySmartWallet();
    await deployDepth();

    await Promise.all([usdt, husd].map(async (t) => {
      await impersonateForToken(t, user, "10000");
    }));

    productName = startegyNames[3];
  });

  beforeEach(async function() {
    const receipt = await smartWalletFactory.connect(user).newSmartWallet(globalConfig.address);
    const txReceipt = await receipt.wait();
    const event = txReceipt.events.filter((e) => e.event == "WalletCreated");
    smartWallet = await ethers.getContractAt("SmartWallet", event[0].args["wallet"]);

    await Promise.all([usdt, husd].map(async (t) => {
      await approve(t, user, smartWallet.address);
    }));
  });

  it("invest/withdraw to strategy via wallet", async function() {
    const depositValue = ethers.utils.parseUnits("0.00000000000001", usdt.decimals);

    // deposit to smart wallet
    await smartWallet.connect(user).depositErc20ToWallet(usdt.address, depositValue);
    console.log("Deposited to SmartWallet: ", depositValue.toString());

    // check getCashBalance
    expect(await smartWallet.getCashBalance(usdt.address)).to.equal(depositValue);

    // invest to depth from smart wallet
    await smartWallet.connect(user).investFromWallet(usdt.address, depositValue, productName, { value: ethers.constants.Zero, gasLimit: "10000000" });
    console.log("Invested from wallet: ", depositValue.toString());

    // check invested balance
    const investBalance = await smartWallet.investBalanceOf(usdt.address, productName);
    console.log("Invest Balance Of: ", investBalance.toString());
    expect(depositValue).to.equal(investBalance);

    // withdraw from depth to smart wallet
    await smartWallet.connect(user).withdrawToWallet(usdt.address, investBalance, productName, { gasLimit: "10000000" });
    const cashBalance = await smartWallet.getCashBalance(usdt.address);
    console.log("Actual withdrawn balance: ", cashBalance.toString());

    // check withdrawn balance after slippage
    expect(investBalance.mul(99).div(100).toString()).to.be.bignumber.lessThan(cashBalance.toString());

    // check remaining balance at depth
    const remainingBalance = await smartWallet.investBalanceOf(usdt.address, productName);
    console.log("Remaining balance at Depth: ", remainingBalance.toString());
    // expect(remainingBalance).to.equal(0);

    // withdraw from smart wallet
    const balanceBefore = await usdtContract.balanceOf(user.address);
    await smartWallet.connect(user).withdrawFromWallet(usdt.address, cashBalance);
    const balanceAfter = await usdtContract.balanceOf(user.address);
    console.log("Withdraw from SmartWallet: ", cashBalance.toString());
    console.log("Actual balance increase: ", balanceAfter.sub(balanceBefore).toString());

    const finalCashBalance = await smartWallet.getCashBalance(usdt.address);
    console.log("Final SmartWallet Balance: ", finalCashBalance.toString());

    /* Claim rewards */
    const rewardsTokenAddress = await smartWallet.rewardsTokenAddress(productName);
    const rewardsTokenContract = await ethers.getContractAt("IERC20", rewardsTokenAddress);
    
    const rewardsBefore = await rewardsTokenContract.balanceOf(user.address);
    await smartWallet.connect(user).directClaimRewards(usdt.address, productName, { gasLimit: "10000000" });
    const rewardsAfter = await rewardsTokenContract.balanceOf(user.address);
    console.log("Claimed rewards: ", rewardsAfter.sub(rewardsBefore).toString());
  });

  it("direct invest/withdraw to strategy", async function() {
    const depositValue = ethers.utils.parseUnits("0.00000000000001", usdt.decimals);

    // invest to depth directly
    await smartWallet.connect(user).directInvest(usdt.address, depositValue, productName, { value: ethers.constants.Zero, gasLimit: "10000000" });
    console.log("Directly invested: ", depositValue.toString());

    // check invested balance
    const investBalance = await smartWallet.investBalanceOf(usdt.address, productName);
    console.log("Invest Balance: ", investBalance.toString());
    expect(depositValue.mul(99).div(100).toString()).to.be.bignumber.lessThan(investBalance.toString());

    // withdraw from depth to smart wallet
    const beforeWithdraw = await usdtContract.balanceOf(user.address);
    // the return value would be less than investBalance
    await smartWallet.connect(user).directWithdraw(usdt.address, investBalance, productName, { gasLimit: "10000000" });
    const afterWithdraw = await usdtContract.balanceOf(user.address);
    console.log("Actual withdrawn value: ", afterWithdraw - beforeWithdraw);

    // check remaining balance at depth
    const remainingBalance = await smartWallet.investBalanceOf(usdt.address, productName);
    console.log("Remaining balance at Depth: ", remainingBalance.toString());
    expect(remainingBalance).to.equal(0);
  });
});
