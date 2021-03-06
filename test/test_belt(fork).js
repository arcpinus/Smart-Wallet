const { ethers } = require("hardhat");
const { solidity } = require("ethereum-waffle");
const chai = require("chai");
const BN = require('bn.js');

chai.use(solidity);
chai.use(require('chai-bn')(BN));
const { assert, expect } = chai;

// assets
const usdt = {
  symbol: "USDT",
  address: "0xa71edc38d189767582c38a3145b5873052c3e47a",
  holder: "0xf977814e90da44bfa03b6295a0616a897441acec",
  decimals: 18
};
const husd = {
  symbol: "HUSD",
  address: "0x0298c2b32eae4da002a15f36fdf7615bea3da047",
  holder: "0xcee6de4290a4002de8712d16f8cfba03cb9afcf4",
  decimals: 8
};
const dai = {
  symbol: "DAI",
  address: "0x3d760a45d0887dfd89a2f5385a236b29cb46ed2a",
  holder: "0xf977814e90da44bfa03b6295a0616a897441acec",
  decimals: 18
};
const usdc = {
  symbol: "USDC",
  address: "0x9362bbef4b8313a8aa9f0c9808b80577aa26b73b",
  holder: "0xf977814e90da44bfa03b6295a0616a897441acec",
  decimals: 6
};


// belt
const depositor = "0x6748D7915e2fB29D0b3B43467028C03b4da281a5";
const masterOrbit = "0x24B1652b0D9A3Dc82e06E35f8a2940D8591DFd11";
const lpTokenPoolId = ethers.constants.Zero;

async function impersonateForToken(tokenInfo, receiver, amount) {
  console.log("Impersonating for " + tokenInfo.symbol);

  const token = await ethers.getContractAt("IERC20", tokenInfo.address);
  await receiver.sendTransaction({
    to: tokenInfo.holder,
    value: ethers.utils.parseEther("1.0")
  });

  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [tokenInfo.holder]}
  )

  const signedHolder = await ethers.provider.getSigner(tokenInfo.holder);
  await token.connect(signedHolder).transfer(receiver.address, ethers.utils.parseUnits(amount, tokenInfo.decimals));

  await hre.network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [tokenInfo.holder]}
  )
}

async function approve(tokenInfo, owner, spender) {
  const token = await ethers.getContractAt("IERC20", tokenInfo.address);
  await token.connect(owner).approve(spender, ethers.constants.MaxUint256);
}

// contracts
let globalConfig;
let smartWalletImpl;
let smartWallet;
let smartWalletFactory;
let beltConfig;
let beltStrategyFactory;

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

async function deployBelt() {
  console.log("Deploying BeltStrategy Contracts");

  const BeltConfig = await ethers.getContractFactory("BeltConfig");
  beltConfig = await BeltConfig.deploy(depositor, masterOrbit, lpTokenPoolId);
  await beltConfig.deployed();

  const BeltStrategyFactory = await ethers.getContractFactory("BeltStrategyFactory");
  beltStrategyFactory = await BeltStrategyFactory.deploy(beltConfig.address);
  await beltStrategyFactory.deployed();
}

describe("Belt", function() {
  let deployer, user;

  before(async function() {
    [deployer, user] = await ethers.getSigners();

    await deploySmartWallet();
    await deployBelt();
    await globalConfig.setStrategyFactory("belt", beltStrategyFactory.address);

    await Promise.all([usdt, husd, dai, usdc].map(async (t) => {
      await impersonateForToken(t, user, "10000");
    }));
  });

  beforeEach(async function() {
    const receipt = await smartWalletFactory.connect(deployer).newSmartWallet(globalConfig.address);
    const txReceipt = await receipt.wait();
    const event = txReceipt.events.filter((e) => e.event == "WalletCreated");
    smartWallet = await ethers.getContractAt("SmartWallet", event[0].args["wallet"]);

    await Promise.all([usdt, husd, dai, usdc].map(async (t) => {
      await approve(t, user, smartWallet.address);
    }));
  });

  it("invest/withdraw to strategy via wallet", async function() {
    const depositValue = ethers.utils.parseUnits("100", usdt.decimals);
    await smartWallet.connect(user).depositErc20ToWallet(usdt.address, depositValue);
    expect(await smartWallet.getCashBalance(usdt.address)).to.equal(depositValue, "wrong cash balance");
    const beltLP = await ethers.getContractAt("BeltLP", await beltConfig.beltLP());

    await smartWallet.investFromWallet(usdt.address, depositValue, "belt", { value: ethers.constants.Zero });
    expect(await smartWallet.investBalanceOf(usdt.address, "belt")).to.equal(depositValue, "wrong invest balance");

    await smartWallet.withdrawToWallet(usdt.address, depositValue, "belt");
    expect(await smartWallet.getCashBalance(usdt.address)).to.equal(depositValue, "wrong cash balance");
    expect(await smartWallet.investBalanceOf(usdt.address, "belt")).to.equal(0, "invest balance should be zero");
  });
});
