import dotenv from 'dotenv';
import { expect } from 'chai';
import { starknet, ethers } from 'hardhat';
import { Provider, Account, CallData, Uint256, uint256 } from 'starknet';
import { safeWithL1AvatarExecutionStrategySetup } from './utils';

dotenv.config();

const eth_network = process.env.ETH_NETWORK_URL || '';
const stark_network = process.env.STARKNET_NETWORK_URL || '';
const account_address = process.env.ADDRESS || '';
const account_pk = process.env.PK || '';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('L1 Avatar Execution', function () {
  this.timeout(1000000);

  let signer: ethers.Wallet;
  let safe: ethers.Contract;
  let mockStarknetMessaging: ethers.Contract;
  let l1AvatarExecutionStrategy: ethers.Contract;

  // Using both a starknet hardhat and sn.js account wrapper as hardhat has cleaner deployment flow
  // but sn.js has cleaner contract interactions. Syntax is being integrated soon.
  let account: Account;
  let accountSH: starknet.starknetAccount;
  let starkTxAuthenticator: starknet.StarknetContract;
  let vanillaVotingStrategy: starknet.StarknetContract;
  let vanillaProposalValidationStrategy: starknet.StarknetContract;
  let space: starknet.StarknetContract;
  let ethRelayer: starknet.StarknetContract;

  before(async function () {
    accountSH = await starknet.OpenZeppelinAccount.getAccountFromAddress(
      account_address,
      account_pk,
    );

    account = new Account(
      new Provider({ sequencer: { baseUrl: stark_network } }),
      account_address,
      account_pk,
    );

    const signers = await ethers.getSigners();
    signer = signers[0];

    const starkTxAuthenticatorFactory = await starknet.getContractFactory(
      'sx_StarkTxAuthenticator',
    );
    const vanillaVotingStrategyFactory = await starknet.getContractFactory(
      'sx_VanillaVotingStrategy',
    );
    const vanillaProposalValidationStrategyFactory = await starknet.getContractFactory(
      'sx_VanillaProposalValidationStrategy',
    );
    const ethRelayerFactory = await starknet.getContractFactory('sx_EthRelayerExecutionStrategy');
    const spaceFactory = await starknet.getContractFactory('sx_Space');

    // await accountSH.declare(starkTxAuthenticatorFactory);
    // await accountSH.declare(vanillaVotingStrategyFactory);
    // await accountSH.declare(vanillaProposalValidationStrategyFactory);
    // await accountSH.declare(ethRelayerFactory);
    // await accountSH.declare(spaceFactory);

    try {
      // If the contracts are already declared, this will be skipped
      await accountSH.declare(starkTxAuthenticatorFactory);
      await accountSH.declare(vanillaVotingStrategyFactory);
      await accountSH.declare(vanillaProposalValidationStrategyFactory);
      await accountSH.declare(ethRelayerFactory);
      await accountSH.declare(spaceFactory);
    } catch {}

    starkTxAuthenticator = await accountSH.deploy(starkTxAuthenticatorFactory);
    vanillaVotingStrategy = await accountSH.deploy(vanillaVotingStrategyFactory);
    vanillaProposalValidationStrategy = await accountSH.deploy(
      vanillaProposalValidationStrategyFactory,
    );
    ethRelayer = await accountSH.deploy(ethRelayerFactory);
    space = await accountSH.deploy(spaceFactory);

    // Initializing the space
    const initializeCalldata = CallData.compile({
      _owner: 1,
      _max_voting_duration: 10,
      _min_voting_duration: 10,
      _voting_delay: 0,
      _proposal_validation_strategy: {
        address: vanillaProposalValidationStrategy.address,
        params: [],
      },
      _proposal_validation_strategy_metadata_URI: [],
      _voting_strategies: [{ address: vanillaVotingStrategy.address, params: [] }],
      _voting_strategies_metadata_URI: [],
      _authenticators: [starkTxAuthenticator.address],
      _metadata_URI: [],
      _dao_URI: [],
    });
    await account.execute({
      contractAddress: space.address,
      entrypoint: 'initialize',
      calldata: initializeCalldata,
    });

    const quorum = 1;

    const MockStarknetMessaging = await ethers.getContractFactory('MockStarknetMessaging', signer);
    const messageCancellationDelay = 5 * 60; // seconds
    mockStarknetMessaging = await MockStarknetMessaging.deploy(messageCancellationDelay);

    ({ l1AvatarExecutionStrategy, safe } = await safeWithL1AvatarExecutionStrategySetup(
      signer,
      mockStarknetMessaging.address,
      space.address,
      ethRelayer.address,
      quorum,
    ));

    await starknet.devnet.dump('dump.pkl');
    console.log('Dumped Starknet Devnet State');
  }, 10000000);

  // Recommended to use a big value if interacting with Alpha Goerli
  it('should execute a proposal via the Avatar Execution Strategy connected to a Safe', async function () {
    // // Resetting Starknet Devnet Timestamp
    // await starknet.devnet.setTime(Date.now()/1000);
    await starknet.devnet.restart();
    await starknet.devnet.load('./dump.pkl');
    console.log('Loaded Starknet Devnet State');
    await starknet.devnet.loadL1MessagingContract(eth_network, mockStarknetMessaging.address);

    const proposalTx = {
      to: signer.address,
      value: 0,
      data: '0x11',
      operation: 0,
      salt: 1,
    };

    const abiCoder = new ethers.utils.AbiCoder();
    const executionHash = ethers.utils.keccak256(
      abiCoder.encode(
        ['tuple(address to, uint256 value, bytes data, uint8 operation, uint256 salt)[]'],
        [[proposalTx]],
      ),
    );
    // Represent the execution hash as a Cairo Uint256
    const executionHashUint256: Uint256 = uint256.bnToUint256(executionHash);

    const executionPayload = [
      l1AvatarExecutionStrategy.address,
      executionHashUint256.low,
      executionHashUint256.high,
    ];

    // Propose
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_propose',
      calldata: CallData.compile({
        space: space.address,
        author: account.address,
        executionStrategy: {
          address: ethRelayer.address,
          params: executionPayload,
        },
        userProposalValidationParams: [],
        metadataURI: [],
      }),
    });

    // Vote
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_vote',
      calldata: CallData.compile({
        space: space.address,
        voter: account.address,
        proposalId: { low: '0x1', high: '0x0' },
        choice: '0x1',
        userVotingStrategies: [{ index: '0x0', params: [] }],
        metadataURI: [],
      }),
    });

    // TODO: Advance time so that the maxVotingTimestamp is exceeded
    await starknet.devnet.increaseTime(10);
    await sleep(10000);

    // Execute
    await account.execute({
      contractAddress: space.address,
      entrypoint: 'execute',
      calldata: CallData.compile({
        proposalId: { low: '0x1', high: '0x0' },
        executionPayload: executionPayload,
      }),
    });

    // Propogating message to L1
    const flushL2Response = await starknet.devnet.flush();
    const message_payload = flushL2Response.consumed_messages.from_l2[0].payload;

    // Proposal data can either be extracted from the message sent to L1 (as done here) or from the pulled from the contract directly
    const space_message = message_payload[0];
    const proposal = {
      startTimestamp: message_payload[1],
      minEndTimestamp: message_payload[2],
      maxEndTimestamp: message_payload[3],
      finalizationStatus: message_payload[4],
      executionPayloadHash: message_payload[5],
      executionStrategy: message_payload[6],
      authorAddressType: message_payload[7],
      author: message_payload[8],
      activeVotingStrategies: uint256.uint256ToBN({
        low: message_payload[9],
        high: message_payload[10],
      }),
    };
    const forVotes = uint256.uint256ToBN({
      low: message_payload[11],
      high: message_payload[12],
    });
    const againstVotes = uint256.uint256ToBN({
      low: message_payload[13],
      high: message_payload[14],
    });
    const abstainVotes = uint256.uint256ToBN({
      low: message_payload[15],
      high: message_payload[16],
    });

    console.log('done');

    await l1AvatarExecutionStrategy.execute(
      space_message,
      proposal,
      forVotes,
      againstVotes,
      abstainVotes,
      executionHash,
      [proposalTx],
    );
  }, 10000000);

  it('should revert execution if quorum is not met', async function () {
    await starknet.devnet.restart();
    await starknet.devnet.load('./dump.pkl');
    await starknet.devnet.increaseTime(10);
    console.log('Loaded Starknet Devnet State second time');
    await starknet.devnet.loadL1MessagingContract(eth_network, mockStarknetMessaging.address);

    const proposalTx = {
      to: signer.address,
      value: 0,
      data: '0x22',
      operation: 0,
      salt: 1,
    };

    const abiCoder = new ethers.utils.AbiCoder();
    const executionHash = ethers.utils.keccak256(
      abiCoder.encode(
        ['tuple(address to, uint256 value, bytes data, uint8 operation, uint256 salt)[]'],
        [[proposalTx]],
      ),
    );
    // Represent the execution hash as a Cairo Uint256
    const executionHashUint256: Uint256 = uint256.bnToUint256(executionHash);

    const executionPayload = [
      l1AvatarExecutionStrategy.address,
      executionHashUint256.low,
      executionHashUint256.high,
    ];

    // Propose
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_propose',
      calldata: CallData.compile({
        space: space.address,
        author: account.address,
        executionStrategy: {
          address: ethRelayer.address,
          params: executionPayload,
        },
        userProposalValidationParams: [],
        metadataURI: [],
      }),
    });

    // Vote
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_vote',
      calldata: CallData.compile({
        space: space.address,
        voter: account.address,
        proposalId: { low: '0x1', high: '0x0' },
        choice: '0x2',
        userVotingStrategies: [{ index: '0x0', params: [] }],
        metadataURI: [],
      }),
    });

    // TODO: Advance time so that the maxVotingTimestamp is exceeded
    await starknet.devnet.increaseTime(20);
    await sleep(20000);

    // Execute
    await account.execute({
      contractAddress: space.address,
      entrypoint: 'execute',
      calldata: CallData.compile({
        proposalId: { low: '0x1', high: '0x0' },
        executionPayload: executionPayload,
      }),
    });

    // Propogating message to L1
    const flushL2Response = await starknet.devnet.flush();
    const message_payload = flushL2Response.consumed_messages.from_l2[0].payload;
    console.log(flushL2Response.consumed_messages.from_l2);
    // Proposal data can either be extracted from the message sent to L1 (as done here) or from the pulled from the contract directly
    const space_message = message_payload[0];
    const proposal = {
      startTimestamp: message_payload[1],
      minEndTimestamp: message_payload[2],
      maxEndTimestamp: message_payload[3],
      finalizationStatus: message_payload[4],
      executionPayloadHash: message_payload[5],
      executionStrategy: message_payload[6],
      authorAddressType: message_payload[7],
      author: message_payload[8],
      activeVotingStrategies: uint256.uint256ToBN({
        low: message_payload[9],
        high: message_payload[10],
      }),
    };
    const forVotes = uint256.uint256ToBN({
      low: message_payload[11],
      high: message_payload[12],
    });
    const againstVotes = uint256.uint256ToBN({
      low: message_payload[13],
      high: message_payload[14],
    });
    const abstainVotes = uint256.uint256ToBN({
      low: message_payload[15],
      high: message_payload[16],
    });

    console.log('done');

    await expect(
      l1AvatarExecutionStrategy.execute(
        space_message,
        proposal,
        forVotes,
        againstVotes,
        abstainVotes,
        executionHash,
        [proposalTx],
      ),
    ).to.be.reverted;
  }, 10000000);

  it('should revert execution if voting period is not exceeded', async function () {
    await starknet.devnet.restart();
    await starknet.devnet.load('./dump.pkl');
    await starknet.devnet.increaseTime(10);
    console.log('Loaded Starknet Devnet State second time');
    await starknet.devnet.loadL1MessagingContract(eth_network, mockStarknetMessaging.address);

    const proposalTx = {
      to: signer.address,
      value: 0,
      data: '0x22',
      operation: 0,
      salt: 1,
    };

    const abiCoder = new ethers.utils.AbiCoder();
    const executionHash = ethers.utils.keccak256(
      abiCoder.encode(
        ['tuple(address to, uint256 value, bytes data, uint8 operation, uint256 salt)[]'],
        [[proposalTx]],
      ),
    );
    // Represent the execution hash as a Cairo Uint256
    const executionHashUint256: Uint256 = uint256.bnToUint256(executionHash);

    const executionPayload = [
      l1AvatarExecutionStrategy.address,
      executionHashUint256.low,
      executionHashUint256.high,
    ];

    // Propose
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_propose',
      calldata: CallData.compile({
        space: space.address,
        author: account.address,
        executionStrategy: {
          address: ethRelayer.address,
          params: executionPayload,
        },
        userProposalValidationParams: [],
        metadataURI: [],
      }),
    });

    // Vote
    await account.execute({
      contractAddress: starkTxAuthenticator.address,
      entrypoint: 'authenticate_vote',
      calldata: CallData.compile({
        space: space.address,
        voter: account.address,
        proposalId: { low: '0x1', high: '0x0' },
        choice: '0x1',
        userVotingStrategies: [{ index: '0x0', params: [] }],
        metadataURI: [],
      }),
    });

    try {
      // Execute before maxVotingTimestamp is exceeded
      await account.execute({
        contractAddress: space.address,
        entrypoint: 'execute',
        calldata: CallData.compile({
          proposalId: { low: '0x1', high: '0x0' },
          executionPayload: executionPayload,
        }),
      });
    } catch (err: any) {
      // 'Before max end timestamp' error message
      expect(err.message).to.contain('0x4265666f7265206d617820656e642074696d657374616d70');
    }
  }, 10000000);
});