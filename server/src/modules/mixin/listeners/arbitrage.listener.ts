/**
 * ArbitrageListener
 *
 * This listener service handles events related to arbitrage. It processes the 'arbitrage.create' event,
 * validates event data, updates payment states, and manages arbitrage orders.
 *
 * Dependencies:
 * - SnapshotsService: Service for interacting with Mixin snapshots.
 * - StrategyUserService: Service for managing strategy-related user data.
 * - Helper functions: Utilities for managing timestamps and asset IDs.
 *
 * Events:
 * - 'arbitrage.create': Event triggered to create arbitrage orders.
 *
 * Methods:
 *
 * - constructor: Initializes the service with the injected SnapshotsService and StrategyUserService.
 *
 * - handleArbitrageCreate(details: ArbitrageMemoDetails, snapshot: SafeSnapshot): Handles the 'arbitrage.create' event.
 *   Validates the details and snapshot, updates payment states, and manages arbitrage orders.
 *
 * Notes:
 * - The service ensures that the event data is valid and the arbitrage order is processed securely.
 * - Error handling is implemented to manage errors during the arbitrage process.
 * - The service updates the payment state and creates arbitrage orders based on the received event data.
 */

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SafeSnapshot } from '@mixin.dev/mixin-node-sdk';
import {
  getAssetIDBySymbol,
  getRFC3339Timestamp,
} from 'src/common/helpers/utils';
import { ArbitrageMemoDetails } from 'src/common/types/memo/memo';
import { PaymentState } from 'src/common/entities/strategy.entity';
import { StrategyUserService } from 'src/modules/strategy/strategy-user.service';
import { SnapshotsService } from 'src/modules/mixin/snapshots/snapshots.service';
import { CustomLogger } from 'src/modules/logger/logger.service';

@Injectable()
export class ArbitrageListener {
  private readonly logger = new CustomLogger(ArbitrageListener.name);

  constructor(
    private readonly snapshotService: SnapshotsService,
    private readonly strategyUserService: StrategyUserService,
  ) {}

  @OnEvent('arbitrage.create')
  async handleArbitrageCreate(
    details: ArbitrageMemoDetails,
    snapshot: SafeSnapshot,
  ) {
    if (!details || !snapshot) {
      this.logger.error('Invalid arguments passed to handleArbitrageCreate');
      return;
    }
    const paymentState = await this.strategyUserService.findPaymentStateByIdRaw(
      details.traceId,
    );

    const { baseAssetID, targetAssetID } = getAssetIDBySymbol(details.symbol);
    if (
      snapshot.asset_id != baseAssetID &&
      snapshot.asset_id != targetAssetID
    ) {
      // Transfer asset doesn't match any of symbol, refund
      return await this.snapshotService.refund(snapshot);
    }

    // TODO: check max/min amount when creating

    // First asset
    if (!paymentState) {
      const now = getRFC3339Timestamp();
      return await this.strategyUserService.createPaymentState({
        orderId: details.traceId,
        type: 'arbitrage',
        symbol: details.symbol,
        firstAssetId: snapshot.asset_id,
        firstAssetAmount: snapshot.amount,
        firstSnapshotId: snapshot.snapshot_id,
        createdAt: now,
        updatedAt: now,
      } as PaymentState);
    }

    // Check if second asset
    if (paymentState && !paymentState.secondAssetId) {
      await this.strategyUserService.updatePaymentStateById(details.traceId, {
        secondAssetId: snapshot.asset_id,
        secondAssetAmount: snapshot.amount,
        secondSnapshotId: snapshot.snapshot_id,
        updatedAt: getRFC3339Timestamp(),
      } as PaymentState);

      await this.strategyUserService.createArbitrage({
        orderId: details.traceId,
        userId: snapshot.opponent_id,
        pair: details.symbol,
        amountToTrade: '1',
        minProfitability: '0.01',
        exchangeAName: details.exchangeAName,
        exchangeBName: details.exchangeBName,
        balanceA: paymentState.firstAssetAmount,
        balanceB: snapshot.amount,
        state: 'created',
        createdAt: getRFC3339Timestamp(),
      });
    }
  }
}
