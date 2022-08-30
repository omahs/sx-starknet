import fetch from 'cross-fetch';
import fs from 'fs';
import { _TypedDataEncoder } from '@ethersproject/hash';
import { ethers } from 'ethers';
import { utils } from '@snapshot-labs/sx';
import { defaultProvider, Account, ec, hash } from 'starknet';
import { domain, Propose, proposeTypes } from '../test/shared/types';
import { PROPOSE_SELECTOR } from '../test/shared/constants';

async function main() {
  global.fetch = fetch;

  const starkAccount = new Account(
    defaultProvider,
    process.env.ARGENT_X_ADDRESS!,
    ec.getKeyPair(process.env.ARGENT_X_PK!)
  );
  const ethAccount = new ethers.Wallet(process.env.ETH_PK_1!);

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
  const spaceAddress = '0x5118b2481780aef2b209c2102e2143e2bdd0322cc0ddef1544a5042f4cad4df';

  const usedVotingStrategies = ['0x1']; // Goerli WETH balance voting strategy is index 1
  const metadataUri = 'Hello and welcome to Snapshot X. This is the future of governance.';
  const metadataUriInts = utils.intsSequence.IntsSequence.LEFromString(metadataUri);
  const block = JSON.parse(fs.readFileSync('./test/data/blockGoerli.json').toString());
  const proofs = JSON.parse(fs.readFileSync('./test/data/proofsGoerli.json').toString());
  const proofInputs: utils.storageProofs.ProofInputs = utils.storageProofs.getProofInputs(
    block.number,
    proofs
  );
  const userVotingStrategyParams = [proofInputs.storageProofs[0]];
  const executionStrategy = vanillaExecutionStrategyAddress;
  const executionParams = ['0x1']; // Random params
  const executionHash = hash.computeHashOnElements(executionParams);
  const proposerEthAddress = ethAccount.address;
  const proposeCalldata = utils.encoding.getProposeCalldata(
    proposerEthAddress,
    metadataUriInts,
    executionStrategy,
    usedVotingStrategies,
    userVotingStrategyParams,
    executionParams
  );

  const salt = utils.splitUint256.SplitUint256.fromHex(
    utils.bytes.bytesToHex(ethers.utils.randomBytes(4))
  );
  const executionHashStr = utils.encoding.hexPadRight(executionHash);

  const message: Propose = {
    space: utils.encoding.hexPadRight(spaceAddress),
    proposerAddress: utils.encoding.hexPadRight(proposerEthAddress),
    metadataUri: metadataUri,
    executor: utils.encoding.hexPadRight(vanillaExecutionStrategyAddress),
    executionParamsHash: utils.encoding.hexPadRight(executionHash),
    usedVotingStrategiesHash: utils.encoding.hexPadRight(
      hash.computeHashOnElements(usedVotingStrategies)
    ),
    userVotingStrategyParamsFlatHash: utils.encoding.hexPadRight(
      hash.computeHashOnElements(utils.encoding.flatten2DArray(userVotingStrategyParams))
    ),
    salt: salt.toHex(),
  };
  const sig = await ethAccount._signTypedData(domain, proposeTypes, message);
  const { r, s, v } = utils.encoding.getRSVFromSig(sig);

  const { transaction_hash: txHash } = await starkAccount.execute(
    {
      contractAddress: ethSigAuthenticatorAddress,
      entrypoint: 'authenticate',
      calldata: [
        r.low,
        r.high,
        s.low,
        s.high,
        v,
        salt.low,
        salt.high,
        spaceAddress,
        PROPOSE_SELECTOR,
        proposeCalldata.length,
        ...proposeCalldata,
      ],
    },
    undefined,
    { maxFee: '857400005301800' }
  );
  console.log('Waiting for confirmation, transaction hash: ', txHash);
  await defaultProvider.waitForTransaction(txHash);
  console.log('---- PROPOSAL CREATED ----');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
