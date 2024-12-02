import { ethers } from 'ethers';
import { BaseComponent } from './BaseComponent.js';
import { isDebugEnabled } from '../config.js';

export class Cleanup extends BaseComponent {
    constructor(containerId) {
        super('cleanup-container');
        this.webSocket = window.webSocket;
        
        this.debug = (message, ...args) => {
            if (isDebugEnabled('CLEANUP')) {
                console.log('[Cleanup]', message, ...args);
            }
        };
    }

    async initialize(readOnlyMode = true) {
        try {
            this.debug('Initializing cleanup component...');
            
            // Wait for both WebSocket and Contract to be ready
            if (!this.webSocket?.isInitialized || !this.webSocket?.contract) {
                this.debug('Waiting for WebSocket service and contract to initialize...');
                let attempts = 0;
                while (attempts < 10) {
                    if (window.webSocket?.isInitialized && window.webSocket?.contract) {
                        this.webSocket = window.webSocket;
                        this.debug('WebSocket service and contract found');
                        break;
                    }
                    this.debug(`Attempt ${attempts + 1}: Waiting for WebSocket...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    attempts++;
                }
            }

            // Verify both WebSocket and Contract are available
            if (!this.webSocket?.isInitialized || !this.webSocket?.contract) {
                throw new Error('WebSocket service or contract not properly initialized');
            }

            // Setup WebSocket event listeners
            this.setupWebSocket();

            this.container.innerHTML = '';
            
            if (readOnlyMode) {
                this.debug('Read-only mode, showing connect prompt');
                this.container.innerHTML = `
                    <div class="tab-content-wrapper">
                        <h2>Cleanup Expired Orders</h2>
                        <p class="connect-prompt">Connect wallet to view cleanup opportunities</p>
                    </div>`;
                return;
            }

            this.debug('Setting up UI components');
            const wrapper = this.createElement('div', 'tab-content-wrapper');
            wrapper.innerHTML = `
                <div class="cleanup-section">
                    <h2>Cleanup Expired Orders</h2>
                    <div class="cleanup-info">
                        <p>Earn fees by cleaning up expired orders</p>
                        <div class="cleanup-stats">
                            <div class="cleanup-category">
                                <h3>Active Orders</h3>
                                <div>Count: <span id="active-orders-count">Loading...</span></div>
                                <div>Fees: <span id="active-orders-fees">Loading...</span></div>
                            </div>
                            <div class="cleanup-category">
                                <h3>Cancelled Orders</h3>
                                <div>Count: <span id="cancelled-orders-count">Loading...</span></div>
                                <div>Fees: <span id="cancelled-orders-fees">Loading...</span></div>
                            </div>
                            <div class="cleanup-category">
                                <h3>Filled Orders</h3>
                                <div>Count: <span id="filled-orders-count">Loading...</span></div>
                                <div>Fees: <span id="filled-orders-fees">Loading...</span></div>
                            </div>
                            <div class="cleanup-total">
                                <h3>Total</h3>
                                <div>Orders Ready: <span id="cleanup-ready">Loading...</span></div>
                                <div>Total Reward: <span id="cleanup-reward">Loading...</span></div>
                            </div>
                        </div>
                    </div>
                    <button id="cleanup-button" class="action-button" disabled>
                        Clean Orders
                    </button>
                </div>
            `;
            
            this.container.appendChild(wrapper);

            this.cleanupButton = document.getElementById('cleanup-button');
            this.cleanupButton.addEventListener('click', () => this.performCleanup());

            this.debug('Starting cleanup opportunities check');
            await this.checkCleanupOpportunities();
            
            this.intervalId = setInterval(() => this.checkCleanupOpportunities(), 5 * 60 * 1000);
            this.debug('Initialization complete');
        } catch (error) {
            this.debug('Initialization failed:', error);
            this.showError('Failed to initialize cleanup component');
            this.updateUIForError();
        }
    }

    cleanup() {
        if (this.intervalId) {
            this.debug('Cleaning up interval');
            clearInterval(this.intervalId);
        }
    }

    async checkCleanupOpportunities() {
        try {
            // Verify WebSocket and contract before proceeding
            if (!this.webSocket?.contract) {
                throw new Error('Contract not available for cleanup check');
            }

            const orders = this.webSocket.getOrders();
            if (!Array.isArray(orders)) {
                throw new Error('Invalid orders data received from WebSocket');
            }

            const eligibleOrders = {
                active: [],
                cancelled: [],
                filled: []
            };
            let activeFees = 0;
            let cancelledFees = 0;
            let filledFees = 0;
            
            for (const order of orders) {
                const { isEligible, order: orderDetails } = await this.webSocket.checkCleanupEligibility(order.id);
                if (isEligible) {
                    if (orderDetails.status === 'Active') {
                        eligibleOrders.active.push(orderDetails);
                        activeFees += Number(orderDetails.orderCreationFee || 0);
                    } else if (orderDetails.status === 'Canceled') {
                        eligibleOrders.cancelled.push(orderDetails);
                        cancelledFees += Number(orderDetails.orderCreationFee || 0);
                    } else if (orderDetails.status === 'Filled') {
                        eligibleOrders.filled.push(orderDetails);
                        filledFees += Number(orderDetails.orderCreationFee || 0);
                    }
                }
            }
            
            const totalEligible = eligibleOrders.active.length + 
                eligibleOrders.cancelled.length + 
                eligibleOrders.filled.length;
            const totalFees = activeFees + cancelledFees + filledFees;
            
            // Update UI elements
            const elements = {
                activeCount: document.getElementById('active-orders-count'),
                activeFees: document.getElementById('active-orders-fees'),
                cancelledCount: document.getElementById('cancelled-orders-count'),
                cancelledFees: document.getElementById('cancelled-orders-fees'),
                filledCount: document.getElementById('filled-orders-count'),
                filledFees: document.getElementById('filled-orders-fees'),
                totalReward: document.getElementById('cleanup-reward'),
                totalReady: document.getElementById('cleanup-ready'),
                cleanupButton: document.getElementById('cleanup-button')
            };
            
            if (elements.activeCount) {
                elements.activeCount.textContent = eligibleOrders.active.length.toString();
            }
            if (elements.activeFees) {
                elements.activeFees.textContent = `${this.formatEth(activeFees)} POL`;
            }
            if (elements.cancelledCount) {
                elements.cancelledCount.textContent = eligibleOrders.cancelled.length.toString();
            }
            if (elements.cancelledFees) {
                elements.cancelledFees.textContent = `${this.formatEth(cancelledFees)} POL`;
            }
            if (elements.filledCount) {
                elements.filledCount.textContent = eligibleOrders.filled.length.toString();
            }
            if (elements.filledFees) {
                elements.filledFees.textContent = `${this.formatEth(filledFees)} POL`;
            }
            if (elements.totalReward) {
                elements.totalReward.textContent = `${this.formatEth(totalFees)} POL`;
            }
            if (elements.totalReady) {
                elements.totalReady.textContent = totalEligible.toString();
            }
            if (elements.cleanupButton) {
                elements.cleanupButton.disabled = totalEligible === 0;
                const batchSize = Math.min(totalEligible, 10); // Using contract's MAX_CLEANUP_BATCH
                if (totalEligible > 10) {
                    elements.cleanupButton.textContent = `Clean ${batchSize} of ${totalEligible} Orders`;
                } else {
                    elements.cleanupButton.textContent = `Clean ${batchSize} Order${batchSize !== 1 ? 's' : ''}`;
                }
            }

            this.debug('Cleanup stats:', {
                active: {
                    count: eligibleOrders.active.length,
                    fees: this.formatEth(activeFees)
                },
                cancelled: {
                    count: eligibleOrders.cancelled.length,
                    fees: this.formatEth(cancelledFees)
                },
                filled: {
                    count: eligibleOrders.filled.length,
                    fees: this.formatEth(filledFees)
                },
                total: {
                    count: totalEligible,
                    fees: this.formatEth(totalFees)
                }
            });

        } catch (error) {
            this.debug('Error checking cleanup opportunities:', error);
            this.showError('Failed to check cleanup opportunities');
            this.updateUIForError();
        }
    }

    updateUIForError() {
        const errorText = 'Error';
        ['active-orders-count', 'active-orders-fees', 
         'cancelled-orders-count', 'cancelled-orders-fees',
         'filled-orders-count', 'filled-orders-fees',
         'cleanup-reward', 'cleanup-ready'].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.textContent = errorText;
        });
    }

    setupWebSocket() {
        if (!this.webSocket) {
            this.debug('WebSocket not available for setup');
            return;
        }

        // Subscribe to all relevant events
        this.webSocket.subscribe('OrderCleaned', () => {
            this.debug('Order cleaned event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('OrderCanceled', () => {
            this.debug('Order canceled event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('OrderFilled', () => {
            this.debug('Order filled event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('orderSyncComplete', () => {
            this.debug('Order sync complete event received');
            this.checkCleanupOpportunities();
        });
    }

    async performCleanup() {
        try {
            // Get contract with signer
            const contract = this.webSocket?.contract;
            if (!contract) {
                throw new Error('Contract not initialized');
            }

            // Check if provider and wallet are connected
            if (!contract.provider) {
                throw new Error('Provider not available');
            }

            // Add these checks for wallet connection
            if (!window.walletManager?.isConnected) {
                throw new Error('Wallet not connected');
            }

            // Get signer from wallet manager
            const signer = await window.walletManager.getSigner();
            if (!signer) {
                throw new Error('No signer available');
            }

            const contractWithSigner = contract.connect(signer);

            this.cleanupButton.disabled = true;
            this.cleanupButton.textContent = 'Cleaning...';

            // Get number of eligible orders to estimate gas better
            const orders = this.webSocket.getOrders();
            const eligibleOrderCount = orders.filter(order => 
                order.isEligible && (order.status === 'Active' || order.status === 'Canceled')
            ).length;

            // Dynamic base gas estimate based on number of orders
            const baseGasEstimate = ethers.BigNumber.from('100000') // Base cost
                .add(ethers.BigNumber.from('50000').mul(eligibleOrderCount)); // Per-order cost

            // Try to get actual gas estimate, fall back to calculated estimate
            const gasEstimate = await contractWithSigner.estimateGas.cleanupExpiredOrders()
                .catch(error => {
                    console.log('[Cleanup] Gas estimation failed:', error);
                    return baseGasEstimate;
                });

            // Add 20% buffer to gas estimate
            const gasLimit = gasEstimate.mul(120).div(100);

            const feeData = await contract.provider.getFeeData();
            if (!feeData || !feeData.gasPrice) {
                throw new Error('Unable to get current gas prices');
            }

            const txOptions = {
                gasLimit,
                gasPrice: feeData.gasPrice,
                type: 0  // Force legacy transaction
            };

            console.log('[Cleanup] Sending transaction with options:', txOptions);
            const tx = await contractWithSigner.cleanupExpiredOrders(txOptions);
            console.log('[Cleanup] Transaction sent:', tx.hash);

            const receipt = await tx.wait();
            console.log('[Cleanup] Transaction confirmed:', receipt);
            console.log('[Cleanup] Events:', receipt.events);

            if (receipt.status === 0) {
                throw new Error('Transaction failed during execution');
            }

            // Parse cleanup events from receipt
            const cleanedOrderIds = receipt.events
                ?.filter(event => {
                    console.log('[Cleanup] Processing event:', event);
                    return event.event === 'OrderCleanedUp';
                })
                ?.map(event => {
                    console.log('[Cleanup] Cleaned order:', event.args);
                    return event.args.orderId.toString();
                });
                
            console.log('[Cleanup] Cleaned order IDs:', cleanedOrderIds);
                
            if (cleanedOrderIds?.length) {
                this.debug('Orders cleaned:', cleanedOrderIds);
                // Remove cleaned orders from WebSocket cache
                this.webSocket.removeOrders(cleanedOrderIds);
                // Force a fresh sync
                await this.webSocket.syncAllOrders(contract);
            }

            this.showSuccess('Cleanup successful! Check your wallet for rewards.');
            await this.checkCleanupOpportunities();

        } catch (error) {
            console.error('[Cleanup] Error details:', {
                message: error.message,
                code: error.code,
                error: error.error,
                reason: error.reason,
                transaction: error.transaction
            });
            this.showError(`Cleanup failed: ${error.message}`);
        } finally {
            this.cleanupButton.textContent = 'Clean Orders';
            this.cleanupButton.disabled = false;
        }
    }

    showSuccess(message) {
        this.debug('Success:', message);
        // Implement your success notification
    }

    showError(message) {
        this.debug('Error:', message);
        // Implement your error notification
    }

    // Add helper method to format ETH values
    formatEth(wei) {
        return ethers.utils.formatEther(wei.toString());
    }
} 