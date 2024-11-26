import { ViewOrders } from './ViewOrders.js';
import { ethers } from 'ethers';
import { isDebugEnabled } from '../config.js';

export class MyOrders extends ViewOrders {
    constructor() {
        super('my-orders');
        
        // Initialize debug logger
        this.debug = (message, ...args) => {
            if (isDebugEnabled('MY_ORDERS')) {
                console.log('[MyOrders]', message, ...args);
            }
        };
    }

    async initialize() {
        try {
            this.debug('Starting initialization...');
            // Cleanup previous state
            this.cleanup();
            this.debug('Container HTML before clear:', this.container.innerHTML);
            this.container.innerHTML = '';
            
            await this.setupTable();
            this.debug('Table setup complete');
            
            // Wait for WebSocket initialization (reusing parent class method)
            if (!window.webSocket?.isInitialized) {
                this.debug('Waiting for WebSocket initialization...');
                await new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (window.webSocket?.isInitialized) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
            }

            // Subscribe to order events
            this.setupWebSocket();

            // Get initial orders from cache and filter for user
            const userAddress = await window.walletManager.getAccount();
            const cachedOrders = window.webSocket.getOrders()
                .filter(order => order.maker.toLowerCase() === userAddress.toLowerCase());

            if (cachedOrders.length > 0) {
                this.debug('Loading orders from cache:', cachedOrders);
                cachedOrders.forEach(order => {
                    this.orders.set(order.id, order);
                });
            }

            // Always call refreshOrdersView to either show orders or empty state
            const tbody = this.container.querySelector('tbody');
            if (!cachedOrders.length) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="10" class="no-orders-message">
                            <div class="placeholder-text">
                                No orders found where you are the maker
                            </div>
                        </td>
                    </tr>`;
            } else {
                await this.refreshOrdersView();
            }

        } catch (error) {
            console.error('[MyOrders] Initialization error:', error);
            throw error;
        }
    }

    setupWebSocket() {
        // Subscribe to order sync completion with user filter
        this.eventSubscriptions.add({
            event: 'orderSyncComplete',
            callback: async (orders) => {
                const userAddress = await window.walletManager.getAccount();
                this.orders.clear();
                
                Object.values(orders)
                    .filter(order => order.maker.toLowerCase() === userAddress.toLowerCase())
                    .forEach(order => {
                        this.orders.set(order.id, order);
                    });
                
                this.refreshOrdersView().catch(error => {
                    console.error('[MyOrders] Error refreshing orders after sync:', error);
                });
            }
        });

        // Subscribe to new orders
        this.eventSubscriptions.add({
            event: 'OrderCreated',
            callback: async (orderData) => {
                const userAddress = await window.walletManager.getAccount();
                if (orderData.maker.toLowerCase() === userAddress.toLowerCase()) {
                    this.debug('New order received:', orderData);
                    this.orders.set(orderData.id, orderData);
                    this.refreshOrdersView().catch(error => {
                        console.error('[MyOrders] Error refreshing after new order:', error);
                    });
                }
            }
        });

        // Subscribe to filled/canceled orders
        ['OrderFilled', 'OrderCanceled'].forEach(event => {
            this.eventSubscriptions.add({
                event,
                callback: (order) => {
                    this.debug(`Order ${event.toLowerCase()}:`, order);
                    if (this.orders.has(order.id)) {
                        this.orders.get(order.id).status = event === 'OrderFilled' ? 'Filled' : 'Canceled';
                        this.refreshOrdersView().catch(error => {
                            console.error('[MyOrders] Error refreshing after order status change:', error);
                        });
                    }
                }
            });
        });

        // Register all subscriptions
        this.eventSubscriptions.forEach(sub => {
            window.webSocket.subscribe(sub.event, sub.callback);
        });
    }

    async cancelOrder(orderId) {
        const button = this.container.querySelector(`button[data-order-id="${orderId}"]`);
        try {
            if (button) {
                button.disabled = true;
                button.textContent = 'Canceling...';
            }

            this.debug('Starting cancel order process for orderId:', orderId);
            const contract = await this.getContract();
            
            // Estimate gas for cancelOrder with fallback
            let cancelGasLimit;
            try {
                const cancelGasEstimate = await contract.estimateGas.cancelOrder(orderId);
                cancelGasLimit = Math.floor(cancelGasEstimate.toNumber() * 1.2); // 20% buffer
                this.debug('Cancel order gas estimate:', cancelGasEstimate.toString());
            } catch (error) {
                this.debug('Gas estimation failed for cancel order, using default:', error);
                cancelGasLimit = 100000; // Default gas limit for cancel orders
            }

            this.debug('Sending cancel order transaction with params:', {
                orderId,
                gasLimit: cancelGasLimit,
                gasPrice: (await this.provider.getGasPrice()).toString()
            });

            const tx = await contract.cancelOrder(orderId, {
                gasLimit: cancelGasLimit,
                gasPrice: await this.provider.getGasPrice()
            });
            
            this.debug('Cancel transaction sent:', tx.hash);
            await tx.wait();
            this.debug('Transaction confirmed');

            this.showSuccess('Order canceled successfully');
            
            // Note: The order will be removed from the table when we receive the
            // OrderCanceled event through WebSocket
        } catch (error) {
            this.debug('Cancel order error details:', {
                message: error.message,
                code: error.code,
                data: error?.error?.data,
                reason: error?.reason,
                stack: error.stack
            });
            
            let errorMessage = 'Failed to cancel order: ';
            
            // Try to decode the error
            if (error?.error?.data) {
                try {
                    const decodedError = this.contract.interface.parseError(error.error.data);
                    errorMessage += `${decodedError.name}: ${decodedError.args}`;
                    this.debug('Decoded error:', decodedError);
                } catch (e) {
                    // If we can't decode the error, fall back to basic messages
                    if (error.code === -32603) {
                        errorMessage += 'Transaction would fail. Please try again.';
                    } else {
                        errorMessage += error.message;
                    }
                }
            }
            
            this.showError(errorMessage);
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = 'Cancel';
            }
        }
    }

    async createOrderRow(order, tokenDetailsMap) {
        const tr = this.createElement('tr');
        tr.dataset.orderId = order.id.toString();

        const sellTokenDetails = tokenDetailsMap.get(order.sellToken);
        const buyTokenDetails = tokenDetailsMap.get(order.buyToken);
        const expiryTime = this.getExpiryTime(order.timestamp);
        const status = this.getOrderStatus(order, expiryTime);

        // Format taker display
        const takerDisplay = order.taker === ethers.constants.AddressZero 
            ? '<span class="open-order">Open to All</span>'
            : `<span class="targeted-order" title="${order.taker}">Specific Taker</span>`;

        tr.innerHTML = `
            <td>${order.id}</td>
            <td>${sellTokenDetails?.symbol || 'Unknown'}</td>
            <td>${ethers.utils.formatUnits(order.sellAmount, sellTokenDetails?.decimals || 18)}</td>
            <td>${buyTokenDetails?.symbol || 'Unknown'}</td>
            <td>${ethers.utils.formatUnits(order.buyAmount, buyTokenDetails?.decimals || 18)}</td>
            <td>${this.formatTimestamp(order.timestamp)}</td>
            <td>${this.formatExpiry(order.timestamp)}</td>
            <td class="order-status">${status}</td>
            <td class="taker-column">${takerDisplay}</td>
            <td class="action-column">
                ${status === 'Active' ? 
                    `<button class="cancel-button" data-order-id="${order.id}">Cancel</button>` : 
                    '<span class="order-completed">Completed</span>'
                }
            </td>`;

        // Add click handler for cancel button
        const cancelButton = tr.querySelector('.cancel-button');
        if (cancelButton) {
            cancelButton.addEventListener('click', () => this.cancelOrder(order.id));
        }

        return tr;
    }

    async refreshOrdersView() {
        this.debug('Refreshing orders view');
        try {
            // Get contract instance first
            this.contract = await this.getContract();
            if (!this.contract) {
                throw new Error('Contract not initialized');
            }

            // Clear existing orders from table
            const tbody = this.container.querySelector('tbody');
            if (!tbody) {
                this.debug('Table body not found');
                return;
            }
            tbody.innerHTML = '';

            // Get filter state
            const showOnlyActive = this.container.querySelector('#fillable-orders-toggle')?.checked;

            // Filter orders if necessary
            let ordersToDisplay = Array.from(this.orders.values());
            if (showOnlyActive) {
                ordersToDisplay = ordersToDisplay.filter(order => 
                    this.getOrderStatus(order, this.getExpiryTime(order.timestamp)) === 'Active'
                );
            }

            // Check if we have any orders after filtering
            if (!ordersToDisplay || ordersToDisplay.length === 0) {
                this.debug('No orders to display after filtering');
                tbody.innerHTML = `
                    <tr>
                        <td colspan="10" class="no-orders-message">
                            <div class="placeholder-text">
                                ${showOnlyActive ? 'No active orders found' : 'No orders found'}
                            </div>
                        </td>
                    </tr>`;
                return;
            }

            // Get token details and display orders
            const tokenAddresses = new Set();
            ordersToDisplay.forEach(order => {
                if (order?.sellToken) tokenAddresses.add(order.sellToken);
                if (order?.buyToken) tokenAddresses.add(order.buyToken);
            });

            const tokenDetails = await this.getTokenDetails(Array.from(tokenAddresses));
            const tokenDetailsMap = new Map();
            tokenDetails.forEach((details, index) => {
                if (details) {
                    tokenDetailsMap.set(Array.from(tokenAddresses)[index], details);
                }
            });

            // Add orders to table
            for (const order of ordersToDisplay) {
                if (order) {
                    const row = await this.createOrderRow(order, tokenDetailsMap);
                    tbody.appendChild(row);
                }
            }
        } catch (error) {
            console.error('[MyOrders] Error refreshing orders view:', error);
            throw error;
        }
    }
}