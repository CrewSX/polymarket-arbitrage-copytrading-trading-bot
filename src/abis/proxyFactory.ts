/**
 * Proxy Factory ABI
 * Used for creating proxy wallets and executing transactions through them
 */
export const proxyFactoryAbi = [
    {
        inputs: [
            {
                components: [
                    {
                        internalType: "address",
                        name: "to",
                        type: "address",
                    },
                    {
                        internalType: "uint8",
                        name: "typeCode",
                        type: "uint8",
                    },
                    {
                        internalType: "bytes",
                        name: "data",
                        type: "bytes",
                    },
                    {
                        internalType: "uint256",
                        name: "value",
                        type: "uint256",
                    },
                ],
                internalType: "struct ProxyWalletFactory.Transaction[]",
                name: "transactions",
                type: "tuple[]",
            },
        ],
        name: "proxy",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
];

