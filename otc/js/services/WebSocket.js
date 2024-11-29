import { ethers } from 'ethers';
import { getNetworkConfig, isDebugEnabled } from '../config.js';

export class WebSocketService {
    constructor() {
        this.provider = null;
        this.subscribers = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.orderCache = new Map();
        this.isInitialized = false;
        
        this.debug = (message, ...args) => {
            if (isDebugEnabled('WEBSOCKET')) {
                console.log('[WebSocket]', message, ...args);
            }
        };
    }

    async initialize() {
        try {
            if (this.isInitialized) return true;
            this.debug('Starting initialization...');
            
            const config = getNetworkConfig();
            this.debug('Network config loaded, connecting to:', config.wsUrl);
            
            this.provider = new ethers.providers.WebSocketProvider(config.wsUrl);
            
            // Wait for provider to be ready
            await this.provider.ready;
            this.debug('Provider ready');

            const contract = new ethers.Contract(
                config.contractAddress,
                config.contractABI,
                this.provider
            );

            this.debug('Contract initialized, starting order sync...');
            await this.syncAllOrders(contract);
            this.debug('Setting up event listeners...');
            await this.setupEventListeners(contract);
            
            this.isInitialized = true;
            this.debug('Initialization complete');
            this.reconnectAttempts = 0;
            
            return true;
        } catch (error) {
            this.debug('Initialization failed:', error);
            return this.reconnect();
        }
    }

    async setupEventListeners(contract) {
        try {
            this.debug('Setting up event listeners for contract:', contract.address);
            
            // Add connection state tracking
            this.provider.on("connect", () => {
                this.debug('Provider connected');
            });
            
            this.provider.on("disconnect", (error) => {
                this.debug('Provider disconnected:', error);
                this.reconnect();
            });

            // Test event subscription
            const filter = contract.filters.OrderCreated();
            this.debug('Created filter:', filter);
            
            // Listen for new blocks to ensure connection is alive
            this.provider.on("block", (blockNumber) => {
                this.debug('New block received:', blockNumber);
            });

            contract.on("OrderCreated", (...args) => {
                try {
                    this.debug('OrderCreated event received (raw):', args);
                    const [orderId, maker, taker, sellToken, sellAmount, buyToken, buyAmount, timestamp, fee, event] = args;
                    
                    const orderData = {
                        id: orderId.toNumber(),
                        maker,
                        taker,
                        sellToken,
                        sellAmount,
                        buyToken,
                        buyAmount,
                        timestamp: timestamp.toNumber(),
                        orderCreationFee: fee,
                        status: 'Active'
                    };
                    
                    this.debug('Processed OrderCreated data:', orderData);
                    
                    // Update cache
                    this.orderCache.set(orderId.toNumber(), orderData);
                    this.debug('Cache updated:', Array.from(this.orderCache.entries()));
                    
                    // Log subscribers before notification
                    this.debug('Current subscribers for OrderCreated:', 
                        this.subscribers.get("OrderCreated")?.size || 0);
                    
                    this.notifySubscribers("OrderCreated", orderData);
                } catch (error) {
                    this.debug('Error in OrderCreated handler:', error);
                }
            });

            contract.on("OrderFilled", (...args) => {
                const [orderId] = args;
                const orderIdNum = orderId.toNumber();
                const order = this.orderCache.get(orderIdNum);
                if (order) {
                    order.status = 'Filled';
                    this.orderCache.set(orderIdNum, order);
                    this.debug('Cache updated for filled order:', order);
                    this.notifySubscribers("OrderFilled", order);
                }
            });

            contract.on("OrderCanceled", (orderId, maker, timestamp, event) => {
                const order = this.orderCache.get(orderId.toNumber());
                if (order) {
                    order.status = 'Canceled';
                    this.updateOrderCache(orderId.toNumber(), order);
                    this.notifySubscribers("OrderCanceled", order);
                }
            });
            
            this.debug('Event listeners setup complete');
        } catch (error) {
            this.debug('Error setting up event listeners:', error);
        }
    }

    async syncAllOrders(contract) {
        try {
            this.debug('Starting order sync with contract:', contract.address);
            
            // Get current order state directly from contract
            let nextOrderId = 0;
            try {
                nextOrderId = await contract.nextOrderId();
                this.debug('nextOrderId result:', nextOrderId.toString());
            } catch (error) {
                this.debug('nextOrderId call failed, using default value:', error);
            }

            // Clear existing cache before sync
            this.orderCache.clear();
            
            // Always sync from 0 to ensure we don't miss any orders
            for (let i = 0; i < nextOrderId; i++) {
                try {
                    const order = await contract.orders(i);
                    // Only add non-zero address orders that are Active
                    if (order.maker !== ethers.constants.AddressZero && 
                        order.status === 0) { // 0 = Active
                        const orderData = {
                            id: i,
                            maker: order.maker,
                            taker: order.taker,
                            sellToken: order.sellToken,
                            sellAmount: order.sellAmount,
                            buyToken: order.buyToken,
                            buyAmount: order.buyAmount,
                            timestamp: order.timestamp.toNumber(),
                            status: ['Active', 'Filled', 'Canceled'][order.status],
                            orderCreationFee: order.orderCreationFee,
                            tries: order.tries
                        };
                        this.orderCache.set(i, orderData);
                        this.debug('Added order to cache:', orderData);
                    }
                } catch (error) {
                    this.debug(`Failed to read order ${i}:`, error);
                    continue;
                }
            }
            
            this.debug('Order sync complete:', Object.fromEntries(this.orderCache));
            this.notifySubscribers('orderSyncComplete', Object.fromEntries(this.orderCache));
            
        } catch (error) {
            this.debug('Order sync failed:', error);
            this.orderCache.clear();
            this.notifySubscribers('orderSyncComplete', {});
        }
    }

    getOrders(filterStatus = null) {
        try {
            this.debug('Getting orders with filter:', filterStatus);
            const orders = Array.from(this.orderCache.values());
            
            if (filterStatus) {
                return orders.filter(order => order.status === filterStatus);
            }
            
            return orders;
        } catch (error) {
            this.debug('Error getting orders:', error);
            return [];
        }
    }

    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.debug('Max reconnection attempts reached');
            return false;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        this.debug(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.initialize();
    }

    subscribe(eventName, callback) {
        if (!this.subscribers.has(eventName)) {
            this.subscribers.set(eventName, new Set());
        }
        this.subscribers.get(eventName).add(callback);
    }

    unsubscribe(eventName, callback) {
        if (this.subscribers.has(eventName)) {
            this.subscribers.get(eventName).delete(callback);
        }
    }

    // Example method to listen to contract events
    listenToContractEvents(contract, eventName) {
        if (!this.provider) {
            throw new Error('WebSocket not initialized');
        }

        contract.on(eventName, (...args) => {
            const event = args[args.length - 1]; // Last argument is the event object
            const subscribers = this.subscribers.get(eventName);
            if (subscribers) {
                subscribers.forEach(callback => callback(event));
            }
        });
    }

    updateOrderCache(orderId, orderData) {
        this.orderCache.set(orderId, orderData);
    }

    removeOrder(orderId) {
        this.orderCache.delete(orderId);
    }

    removeOrders(orderIds) {
        if (!Array.isArray(orderIds)) {
            console.warn('[WebSocket] removeOrders called with non-array:', orderIds);
            return;
        }
        
        this.debug('Removing orders:', orderIds);
        orderIds.forEach(orderId => {
            this.orderCache.delete(orderId);
        });
        
        // Notify subscribers of the update
        this.notifySubscribers('ordersUpdated', this.getOrders());
    }

    notifySubscribers(eventName, data) {
        this.debug('Notifying subscribers for event:', eventName);
        const subscribers = this.subscribers.get(eventName);
        if (subscribers) {
            this.debug('Found', subscribers.size, 'subscribers');
            subscribers.forEach(callback => {
                try {
                    this.debug('Calling subscriber callback');
                    callback(data);
                    this.debug('Subscriber callback completed');
                } catch (error) {
                    this.debug('Error in subscriber callback:', error);
                }
            });
        } else {
            this.debug('No subscribers found for event:', eventName);
        }
    }

    async checkContractState(contract) {
        try {
            // Get deployer/owner address
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            const currentAccount = accounts[0];
            
            this.debug('Contract state check:', {
                address: contract.address,
                currentAccount,
                bytecodeExists: await contract.provider.getCode(contract.address) !== '0x'
            });
            
            return true;
        } catch (error) {
            this.debug('Contract state check failed:', error);
            return false;
        }
    }

    // Add this method to verify specific order state
    async verifyOrderState(orderId) {
        try {
            const contract = await this.getContract();
            const order = await contract.orders(orderId);
            this.debug('Direct order state check:', {
                orderId,
                exists: order.maker !== ethers.constants.AddressZero,
                status: ['Active', 'Filled', 'Canceled'][order.status],
                timestamp: order.timestamp.toNumber()
            });
            return order;
        } catch (error) {
            this.debug('Error verifying order state:', error);
            return null;
        }
    }

    // Add this method to check if orders are eligible for cleanup
    async checkCleanupEligibility(orderId) {
        try {
            const contract = new ethers.Contract(
                this.contractAddress,
                this.contractABI,
                this.provider
            );

            const order = await contract.orders(orderId);
            const currentTime = Math.floor(Date.now() / 1000);
            const orderTime = order.timestamp.toNumber();
            const totalExpiry = 14 * 24 * 60 * 60; // 14 days in seconds

            this.debug('Cleanup eligibility check:', {
                orderId,
                orderTime,
                currentTime,
                age: currentTime - orderTime,
                requiredAge: totalExpiry,
                isEligible: (currentTime - orderTime) > totalExpiry
            });

            return {
                isEligible: (currentTime - orderTime) > totalExpiry,
                order
            };
        } catch (error) {
            this.debug('Error checking cleanup eligibility:', error);
            return { isEligible: false, error };
        }
    }
}
