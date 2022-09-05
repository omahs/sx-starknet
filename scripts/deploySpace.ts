import fs from 'fs';
import { defaultProvider, Account, ec, json } from 'starknet';
import { utils } from '@snapshot-labs/sx';

async function main() {
  const starkAccount = new Account(
    defaultProvider,
    process.env.ARGENT_X_ADDRESS!,
    ec.getKeyPair(process.env.ARGENT_X_PK!)
  );

  const vanillaAuthenticatorAddress =
    '0x68553dd647a471b197435f212b6536088118c47de5e05f374f224b2977ad20f';
  const ethSigAuthenticatorAddress =
    '0x11e41ee1edc66e4b65fc0aaeca757bdbaeecedc2514fcdf58bb72a3f75518bc';
  const vanillaVotingStrategyAddress =
    '0x1b18d9fe16f47e2cf8abc4e84b3cfd37b94abeae3c5fa6ceb8b6f3bbd1f99f5';
  const ethBalanceOfVotingStrategyAddress =
    '0x71b4f90aec133dd5fb89e9851c1466b2df2ea6dbe7de475915d78394a7dbb1a';
  const vanillaExecutionStrategyAddress =
    '0x7bbb7a6a4b87334716aef338195e8bbd3ac6346654d8118ddc1daeb1260906c';
  const zodiacExecutionStrategyAddress =
    '0x1d5a3e4a86559398b35ab5c959bb20f91737168351b628ffff68404301268de';

  const spaceFactoryAddress = '0x6eb62d281fb2ebdac4c326818204df636457df8da5ce1edea8c9ce546467417';

  const spaceClassHash = '0x7fbabb6a96ed800d66d1ace0de4d216cc19c7308bb15faa0c0252fe2c7af006';
  const votingDelay = 0;
  const minVotingDuration = 0;
  const maxVotingDuration = 200000;
  const votingStrategies = [vanillaVotingStrategyAddress, ethBalanceOfVotingStrategyAddress];
  // First voting strategy is vanilla which has zero paramaters.
  // Second voting strategy is eth balance of which has two parameters, the contract address and the slot index.
  const votingStrategyParams: string[][] = [
    [],
    ['0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6', '0x3'],
  ];
  const votingStrategyParamsFlat = utils.encoding.flatten2DArray(votingStrategyParams);
  const authenticators = [vanillaAuthenticatorAddress, ethSigAuthenticatorAddress];
  const executors = [vanillaExecutionStrategyAddress, zodiacExecutionStrategyAddress];
  const quorum = utils.splitUint256.SplitUint256.fromUint(BigInt(1));
  const proposalThreshold = utils.splitUint256.SplitUint256.fromUint(BigInt(1));
  const controllerAddress = '0x0764c647e4c5f6e81c5baa1769b4554e44851a7b6319791fc6db9e25a32148bb'; // Controller address is orlando's argent x

  // Deploy space contract through space factory.
  const { transaction_hash: txHash } = await starkAccount.execute(
    [
      {
        contractAddress: spaceFactoryAddress,
        entrypoint: 'deploy_space',
        calldata: [
          controllerAddress,
          votingDelay,
          minVotingDuration,
          maxVotingDuration,
          proposalThreshold.low,
          proposalThreshold.high,
          controllerAddress,
          quorum.low,
          quorum.high,
          votingStrategyParamsFlat.length,
          ...votingStrategyParamsFlat,
          votingStrategies.length,
          ...votingStrategies,
          authenticators.length,
          ...authenticators,
          executors.length,
          ...executors,
        ],
      },
    ],
    undefined,
    { maxFee: '857400005301800' }
  );
  console.log('waiting for space to be deployed, transaction hash: ', txHash);
  await defaultProvider.waitForTransaction(txHash);

  // Extracting space address from the event emitted by the space factory.
  const receipt = (await defaultProvider.getTransactionReceipt(txHash)) as any;
  const spaceAddress = receipt.events[1].data[1];

  // Storing deployment config.
  const deployments = {
    spaceFactory: {
      address: spaceFactoryAddress,
      spaceClassHash: spaceClassHash,
    },
    space: {
      name: 'DAO test space',
      address: spaceAddress,
      controller: controllerAddress,
      minVotingDuration: minVotingDuration,
      maxVotingDuration: maxVotingDuration,
      proposalThreshold: proposalThreshold.toHex(),
      quorum: quorum.toHex(),
      authenticators: {
        ethSig: ethSigAuthenticatorAddress,
        vanilla: vanillaAuthenticatorAddress,
      },
      votingStrategies: {
        vanilla: {
          index: 0,
          address: vanillaVotingStrategyAddress,
          parameters: [],
        },
        ethBalanceOf: {
          index: 1,
          address: ethBalanceOfVotingStrategyAddress,
          parameters: ['0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6', '0x3'],
        },
      },
      executionStrategies: {
        vanilla: vanillaExecutionStrategyAddress,
        zodiac: zodiacExecutionStrategyAddress,
      },
    },
  };
  fs.writeFileSync('./deployments/goerli2.json', JSON.stringify(deployments));
  console.log('---- DEPLOYMENT COMPLETE ----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });