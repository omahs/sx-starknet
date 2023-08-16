#[cfg(test)]
mod tests {
    use sx::tests::mocks::erc20_votes_preset::ERC20VotesPreset; // temporary while we wait for scarb to fix their dependencies
    use sx::space::space::{ISpace, ISpaceDispatcher, ISpaceDispatcherTrait};
    use openzeppelin::token::erc20::presets::ERC20VotesPreset::ERC20Impl;
    use openzeppelin::token::erc20::presets::ERC20VotesPreset::VotesImpl;
    use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::governance::utils::interfaces::votes::{
        IVotes, IVotesDispatcher, IVotesDispatcherTrait
    };
    use starknet::{ContractAddress, contract_address_const};
    use starknet::{info, testing};
    use sx::tests::setup::setup::setup::{setup as _setup, deploy, Config};
    use starknet::syscalls::deploy_syscall;
    use starknet::SyscallResult;
    use result::ResultTrait;
    use option::OptionTrait;
    use traits::{Into, TryInto};
    use array::{ArrayTrait, SpanTrait};
    use sx::interfaces::{
        IVotingStrategy, IVotingStrategyDispatcher, IVotingStrategyDispatcherTrait
    };
    use sx::authenticators::vanilla::{
        VanillaAuthenticator, IVanillaAuthenticatorDispatcher, IVanillaAuthenticatorDispatcherTrait
    };
    use sx::voting_strategies::erc20_votes::ERC20VotesVotingStrategy;
    use debug::PrintTrait;
    use sx::types::{
        Choice, Proposal, IndexedStrategy, Strategy, UpdateSettingsCalldata,
        UpdateSettingsCalldataImpl, UserAddress
    };
    use sx::tests::utils::strategy_trait::StrategyImpl;
    use sx::utils::constants::{PROPOSE_SELECTOR, VOTE_SELECTOR};
    use sx::execution_strategies::vanilla::VanillaExecutionStrategy;
    use serde::Serde;

    const NAME: felt252 = 'TEST';
    const SYMBOL: felt252 = 'TST';
    const INITIAL_SUPPLY: u256 = 1_000;

    fn OWNER() -> ContractAddress {
        contract_address_const::<0x111111>()
    }

    fn deploy_token_contract() -> ContractAddress {
        // Deploy ERC20
        let constructor_data = array![
            NAME, SYMBOL, INITIAL_SUPPLY.low.into(), INITIAL_SUPPLY.high.into(), OWNER().into()
        ];

        let (token_contract, _) = deploy_syscall(
            ERC20VotesPreset::TEST_CLASS_HASH.try_into().unwrap(),
            0,
            constructor_data.span(),
            false,
        )
            .unwrap();

        token_contract.into()
    }

    fn strategy_from_contract(token_contract: ContractAddress) -> Strategy {
        let (contract, _) = deploy_syscall(
            ERC20VotesVotingStrategy::TEST_CLASS_HASH.try_into().unwrap(),
            0,
            array![].span(),
            false,
        )
            .unwrap();

        let params: Array<felt252> = array![token_contract.into()];

        Strategy { address: contract, params,  }
    }

    fn setup_space() -> (Config, ISpaceDispatcher) {
        let config = _setup();
        let (factory_address, space) = deploy(@config);

        let token_contract = deploy_token_contract();
        let erc20_voting_strategy = strategy_from_contract(token_contract);
        let to_remove = array![0];
        let to_add = array![erc20_voting_strategy];
        let mut settings = UpdateSettingsCalldataImpl::default();
        settings.voting_strategies_to_add = to_add;
        settings.voting_strategies_to_remove = to_remove;

        testing::set_contract_address(config.owner);
        space.update_settings(settings);
        (config, space)
    }

    fn get_vanilla_execution_strategy() -> Strategy {
        let quorum = 1_u256;
        let mut constructor_calldata = array![];
        quorum.serialize(ref constructor_calldata);

        let (vanilla_execution_strategy_address, _) = deploy_syscall(
            VanillaExecutionStrategy::TEST_CLASS_HASH.try_into().unwrap(),
            0,
            constructor_calldata.span(),
            false
        )
            .unwrap();
        let vanilla_execution_strategy = StrategyImpl::from_address(
            vanilla_execution_strategy_address
        );
        vanilla_execution_strategy
    }

    // Setup 5 accounts with 5 tokens each
    // They each self delegate
    fn setup_accounts(voting_strategy: Strategy) -> Array<ContractAddress> {
        let mut params = voting_strategy.params.span();
        let contract = Serde::<ContractAddress>::deserialize(ref params).unwrap();

        let token_contract = IERC20Dispatcher { contract_address: contract,  };
        // Create accounts
        let account0 = contract_address_const::<0x1234>();
        let account1 = contract_address_const::<0x2345>();
        let account2 = contract_address_const::<0x3456>();
        let account3 = contract_address_const::<0x4567>();
        let account4 = contract_address_const::<0x5678>();

        // Calling from ownwer account
        testing::set_contract_address(OWNER());
        // Fund them
        token_contract.transfer(account0, 5_u256);
        token_contract.transfer(account1, 5_u256);
        token_contract.transfer(account2, 5_u256);
        token_contract.transfer(account3, 5_u256);
        token_contract.transfer(account4, 5_u256);

        let token_contract = IVotesDispatcher { contract_address: contract,  };

        // Make them self delegate
        testing::set_contract_address(account0);
        token_contract.delegate(account0);
        testing::set_contract_address(account1);
        token_contract.delegate(account1);
        testing::set_contract_address(account2);
        token_contract.delegate(account2);
        testing::set_contract_address(account3);
        token_contract.delegate(account3);
        testing::set_contract_address(account4);
        token_contract.delegate(account4);

        testing::set_contract_address(OWNER());

        // Return them
        return array![account0, account1, account2, account3, account4];
    }

    #[test]
    #[available_gas(1000000000)]
    fn test_works() {
        let (config, space) = setup_space();
        let vanilla_execution_strategy = get_vanilla_execution_strategy();
        let accounts = setup_accounts(space.voting_strategies(1));

        let authenticator = IVanillaAuthenticatorDispatcher {
            contract_address: *config.authenticators.at(0), 
        };

        let author = UserAddress::Starknet(contract_address_const::<0x5678>());
        let mut propose_calldata = array::ArrayTrait::<felt252>::new();
        author.serialize(ref propose_calldata);
        vanilla_execution_strategy.serialize(ref propose_calldata);
        ArrayTrait::<felt252>::new().serialize(ref propose_calldata);
        ArrayTrait::<felt252>::new().serialize(ref propose_calldata);

        testing::set_block_number(100);

        // Create Proposal
        authenticator.authenticate(space.contract_address, PROPOSE_SELECTOR, propose_calldata);

        // Increasing block block_number by 1 to pass voting delay
        testing::set_block_number(101);

        let mut vote_calldata = array::ArrayTrait::<felt252>::new();
        let voter = UserAddress::Starknet(contract_address_const::<0x8765>());
        voter.serialize(ref vote_calldata);
        let proposal_id = 1_u256;
        proposal_id.serialize(ref vote_calldata);
        let choice = Choice::For(());
        choice.serialize(ref vote_calldata);
        let mut user_voting_strategies = array![];
        user_voting_strategies.append(IndexedStrategy { index: 1, params: array![] });
        user_voting_strategies.serialize(ref vote_calldata);
        ArrayTrait::<felt252>::new().serialize(ref vote_calldata);

        // Vote on Proposal
        authenticator.authenticate(space.contract_address, VOTE_SELECTOR, vote_calldata);

        testing::set_block_number(102);

        // Execute Proposal
        space.execute(1_u256, vanilla_execution_strategy.params);
    }
}
