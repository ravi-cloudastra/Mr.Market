/**
 * SnapshotsService
 *
 * This service manages interactions with Mixin snapshots, including fetching and processing snapshots,
 * handling deposits and withdrawals, and managing various snapshot-related events.
 *
 * Dependencies:
 * - ConfigService: Provides configuration values from environment variables.
 * - EventEmitter2: Event emitter for managing custom events.
 * - CustomLogger: Custom logging service for recording errors and log information.
 * - SnapshotsRepository: Repository for interacting with snapshot-related data in the database.
 * - MixinApi and associated functions: Mixin Node SDK for interacting with the Mixin network.
 * - Helper functions: Utilities for decoding memos and managing asset IDs and symbols.
 *
 * Methods:
 *
 * - constructor: Initializes the service with the injected ConfigService, EventEmitter2, and SnapshotsRepository,
 *   and sets up the Mixin API client and keystore.
 *
 * - createSnapshot(snapshot: SafeSnapshot): Creates a snapshot record in the database.
 *
 * - fetchAndProcessSnapshots(): Fetches snapshots from the Mixin API and processes each snapshot.
 *
 * - depositAddress(asset_id: string): Retrieves the deposit address for a specific asset.
 *
 * - withdrawal(asset_id: string, destination: string, memo: string, amount: string): Initiates a withdrawal for a specific asset.
 *
 * - sendMixinTx(opponent_id: string, asset_id: string, amount: string): Sends a transaction on the Mixin network.
 *
 * - refund(snapshot: SafeSnapshot): Refunds a specific snapshot amount to the opponent.
 *
 * - getAllAssetBalances(): Retrieves balances for all assets.
 *
 * - getAssetBalance(asset_id: SymbolAssetIdMapValue): Retrieves the balance for a specific asset.
 *
 * - checkMixinBalanceEnough(asset_id: SymbolAssetIdMapValue, amount: string): Checks if the Mixin balance is sufficient for a specific amount.
 *
 * - handleSnapshot(snapshot: SafeSnapshot): Handles processing of a single snapshot, including validating memos and triggering events.
 *
 * - handleSnapshots(): Scheduled task to fetch and process snapshots every 5 seconds.
 *
 * Notes:
 * - Spot order execution process (Here is the step 1)
 *  1. Loop snapshots on mixin, find incoming transfer
 *  2. Send create spot order event to spot.listener.ts
 *  3. If basic checks are passed, send place order event, write to db in exchange.listener.ts
 *  4. Wait for state update scheduler to update order state, in exchange.service.ts
 *  5. If the state updated to succeess, send release token event to mixin.listener.ts
 *
 * - The service handles different types of memos (SP, AR, MM) and triggers corresponding events for spot orders, arbitrage, and market making.
 * - Error handling is implemented to log and manage errors during API interactions and snapshot processing.
 * - The service ensures secure handling of transactions and balances using the Mixin API and related functions.
 */

import { randomUUID } from 'crypto';
import BigNumber from 'bignumber.js';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MixinApi,
  SafeSnapshot,
  KeystoreClientReturnType,
  buildSafeTransactionRecipient,
  Keystore,
  getTotalBalanceFromOutputs,
  getUnspentOutputsForRecipients,
  buildSafeTransaction,
  encodeSafeTransaction,
  signSafeTransaction,
  blake3Hash,
  MixinCashier,
  SequencerTransactionRequest,
  SafeMixinRecipient,
  SafeWithdrawalRecipient,
} from '@mixin.dev/mixin-node-sdk';
import {
  decodeArbitrageMemo,
  decodeMarketMakingMemo,
  decodeSpotMemo,
} from 'src/common/helpers/mixin/memo';
import { CustomLogger } from 'src/modules/logger/logger.service';
import { SpotOrderCreateEvent } from 'src/modules/mixin/events/spot.event';
import { SnapshotsRepository } from 'src/modules/mixin/snapshots/snapshots.repository';
import { SymbolAssetIdMapValue } from 'src/common/types/pairs/pairs';

@Injectable()
export class SnapshotsService {
  private events: EventEmitter2;
  private keystore: Keystore;
  private spendKey: string;
  private client: KeystoreClientReturnType;
  private readonly logger = new CustomLogger(SnapshotsService.name);
  private readonly enableCron: boolean;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
    private snapshotsRepository: SnapshotsRepository,
  ) {
    this.keystore = {
      app_id: this.configService.get<string>('mixin.app_id'),
      session_id: this.configService.get<string>('mixin.session_id'),
      server_public_key: this.configService.get<string>(
        'mixin.server_public_key',
      ),
      session_private_key: this.configService.get<string>(
        'mixin.session_private_key',
      ),
    };
    this.spendKey = this.configService.get<string>('mixin.spend_private_key');
    this.client = MixinApi({
      keystore: this.keystore,
    });
    this.events = this.eventEmitter;

    this.enableCron = this.configService.get<string>('strategy.run') === 'true';
    this.logger.log(`Cron enabled: ${this.enableCron}`);
  }

  async createSnapshot(snapshot: SafeSnapshot) {
    try {
      return await this.snapshotsRepository.createSnapshot(snapshot);
    } catch (e) {
      this.logger.error(`createSnapshot()=> ${e.message}`);
    }
  }

  async fetchAndProcessSnapshots() {
    try {
      const snapshots = await this.client.safe.fetchSafeSnapshots({});
      if (!snapshots) {
        this.logger.error(`fetchAndProcessSnapshots()=> No snapshots`);
        return;
      }
      snapshots.forEach(async (snapshot: SafeSnapshot) => {
        await this.handleSnapshot(snapshot);
      });
      return snapshots;
    } catch (error) {
      this.logger.error(`Failed to fetch snapshots: ${error.message}`);
    }
  }

  async depositAddress(asset_id: string) {
    try {
      const chain_id = (await this.client.network.fetchAsset(asset_id))
        .chain_id;
      const entities = await this.client.safe.depositEntries({
        members: [this.keystore.app_id],
        threshold: 1,
        chain_id,
      });
      return {
        address: entities[0].destination,
        memo: entities[0].tag,
      };
    } catch (error) {
      this.logger.error(`Failed to get deposit address: ${error.message}`);
    }
  }

  async withdrawal(
    asset_id: string,
    destination: string,
    memo: string,
    amount: string,
  ) {
    const asset = await this.client.network.fetchAsset(asset_id);
    const chain =
      asset.chain_id === asset.asset_id
        ? asset
        : await this.client.network.fetchAsset(asset.chain_id);
    const fee = chain;
    this.logger.log(`Withdrawal Fee: ${fee.amount} ${fee.symbol}`);

    // withdrawal with chain asset as fee
    if (fee.asset_id !== asset.asset_id) {
      const outputs = await this.client.utxo.safeOutputs({
        asset: asset_id,
        state: 'unspent',
      });
      const feeOutputs = await this.client.utxo.safeOutputs({
        asset: fee.asset_id,
        state: 'unspent',
      });

      const recipients: (SafeWithdrawalRecipient | SafeMixinRecipient)[] = [
        {
          amount: amount,
          destination: destination,
        },
      ];
      const { utxos, change } = getUnspentOutputsForRecipients(
        outputs,
        recipients,
      );
      if (!change.isZero() && !change.isNegative()) {
        recipients.push(
          buildSafeTransactionRecipient(
            outputs[0].receivers,
            outputs[0].receivers_threshold,
            change.toString(),
          ),
        );
      }
      // the index of ghost keys must be the same with the index of outputs
      // but withdrawal output doesnt need ghost key, so index + 1
      const ghosts = await this.client.utxo.ghostKey(
        recipients
          .filter((r) => 'members' in r)
          .map((r, i) => ({
            hint: randomUUID(),
            receivers: (r as SafeMixinRecipient).members,
            index: i + 1,
          })),
      );
      const tx = buildSafeTransaction(
        utxos,
        recipients,
        [undefined, ...ghosts],
        memo,
      );
      // @ts-expect-error type
      const raw = encodeSafeTransaction(tx);
      const ref = blake3Hash(Buffer.from(raw, 'hex')).toString('hex');

      const feeRecipients = [
        // fee output
        buildSafeTransactionRecipient([MixinCashier], 1, fee.amount),
      ];
      const { utxos: feeUtxos, change: feeChange } =
        getUnspentOutputsForRecipients(feeOutputs, feeRecipients);
      if (!feeChange.isZero() && !feeChange.isNegative()) {
        // add fee change output if needed
        feeRecipients.push(
          buildSafeTransactionRecipient(
            feeOutputs[0].receivers,
            feeOutputs[0].receivers_threshold,
            feeChange.toString(),
          ),
        );
      }
      const feeGhosts = await this.client.utxo.ghostKey(
        feeRecipients.map((r, i) => ({
          hint: randomUUID(),
          // @ts-expect-error type
          receivers: r.members,
          index: i,
        })),
      );
      const feeTx = buildSafeTransaction(
        feeUtxos,
        feeRecipients,
        feeGhosts,
        'withdrawal-fee-memo',
        [ref],
      );
      // @ts-expect-error type
      const feeRaw = encodeSafeTransaction(feeTx);

      const txId = randomUUID();
      const feeId = randomUUID();
      const txs = await this.client.utxo.verifyTransaction([
        {
          raw,
          request_id: txId,
        },
        {
          raw: feeRaw,
          request_id: feeId,
        },
      ]);

      // @ts-expect-error type
      const signedRaw = signSafeTransaction(tx, txs[0].views, this.spendKey);
      const signedFeeRaw = signSafeTransaction(
        // @ts-expect-error type
        feeTx,
        txs[1].views,
        this.spendKey,
      );
      const res = await this.client.utxo.sendTransactions([
        {
          raw: signedRaw,
          request_id: txId,
        },
        {
          raw: signedFeeRaw,
          request_id: feeId,
        },
      ]);
      this.logger.log(`Withdrawal result: ${JSON.stringify(res)}`);
      return res;
    }
    // withdrawal with asset as fee
    else {
      const outputs = await this.client.utxo.safeOutputs({
        asset: asset_id,
        state: 'unspent',
      });

      const recipients = [
        // withdrawal output, must be put first
        {
          amount: amount,
          destination: destination,
        },
        // fee output
        buildSafeTransactionRecipient([MixinCashier], 1, fee.amount),
      ];
      const { utxos, change } = getUnspentOutputsForRecipients(
        outputs,
        recipients,
      );
      if (!change.isZero() && !change.isNegative()) {
        // add change output if needed
        recipients.push(
          buildSafeTransactionRecipient(
            outputs[0].receivers,
            outputs[0].receivers_threshold,
            change.toString(),
          ),
        );
      }
      // the index of ghost keys must be the same with the index of outputs
      // but withdrawal output doesnt need ghost key, so index + 1
      const ghosts = await this.client.utxo.ghostKey(
        recipients
          .filter((r) => 'members' in r)
          .map((r, i) => ({
            hint: randomUUID(),
            receivers: (r as SafeMixinRecipient).members,
            index: i + 1,
          })),
      );
      // spare the 0 inedx for withdrawal output, withdrawal output doesnt need ghost key
      const tx = buildSafeTransaction(
        utxos,
        recipients,
        [undefined, ...ghosts],
        'withdrawal-memo',
      );
      // @ts-expect-error type
      const raw = encodeSafeTransaction(tx);

      const request_id = randomUUID();
      const txs = await this.client.utxo.verifyTransaction([
        {
          raw,
          request_id,
        },
      ]);

      // @ts-expect-error type
      const signedRaw = signSafeTransaction(tx, txs[0].views, this.spendKey);
      const res = await this.client.utxo.sendTransactions([
        {
          raw: signedRaw,
          request_id,
        },
      ]);
      this.logger.log(`Withdrawal result: ${JSON.stringify(res)}`);
      return res;
    }
  }

  async sendMixinTx(
    opponent_id: string,
    asset_id: string,
    amount: string,
  ): Promise<SequencerTransactionRequest[]> {
    const recipients = [
      buildSafeTransactionRecipient([opponent_id], 1, amount),
    ];
    const outputs = await this.client.utxo.safeOutputs({
      members: [this.keystore.app_id],
      threshold: 1,
      asset: asset_id,
      state: 'unspent',
    });

    const balance = getTotalBalanceFromOutputs(outputs);
    const amountBN = BigNumber(amount);
    if (balance.isLessThan(amountBN)) {
      this.logger.error(`Insufficient fund`);
      return;
    }

    const { utxos, change } = getUnspentOutputsForRecipients(
      outputs,
      recipients,
    );
    if (!change.isZero() && !change.isNegative()) {
      recipients.push(
        buildSafeTransactionRecipient(
          outputs[0].receivers,
          outputs[0].receivers_threshold,
          change.toString(),
        ),
      );
    }
    const ghosts = await this.client.utxo.ghostKey(
      recipients.map((r, i) => ({
        hint: randomUUID(),
        receivers: r[0].members,
        index: i,
      })),
    );
    const tx = buildSafeTransaction(utxos, recipients, ghosts, 'Refund');
    // @ts-expect-error type
    const raw = encodeSafeTransaction(tx);

    const request_id = randomUUID();
    const verifiedTx = await this.client.utxo.verifyTransaction([
      {
        raw,
        request_id,
      },
    ]);

    const signedRaw = signSafeTransaction(
      // @ts-expect-error type
      tx,
      verifiedTx[0].views,
      this.keystore.session_private_key,
    );

    const sendedTx = await this.client.utxo.sendTransactions([
      {
        raw: signedRaw,
        request_id,
      },
    ]);
    return sendedTx;
  }

  async refund(snapshot: SafeSnapshot) {
    try {
      await this.sendMixinTx(
        snapshot.opponent_id,
        snapshot.asset_id,
        snapshot.amount,
      );
    } catch (error) {
      this.logger.error(`Failed to refund snapshot: ${error.message}`);
    }
  }

  async getAllAssetBalances() {
    try {
      // Fetch all outputs
      const outputs = await this.client.utxo.safeOutputs({});

      // Group outputs by asset ID
      const groupedByAssetId = outputs.reduce((acc, output) => {
        // @ts-expect-error SDK type is wrong
        const assetId = output.asset_id;
        if (!acc[assetId]) {
          acc[assetId] = [];
        }
        acc[assetId].push(output);
        return acc;
      }, {});

      // Calculate total balance for each asset
      const assetBalances = Object.entries(groupedByAssetId).reduce(
        (acc, [assetId, outputs]) => {
          // @ts-expect-error types
          const totalBalance = getTotalBalanceFromOutputs(outputs);
          acc[assetId] = totalBalance.toString(); // Assuming you want the balance as a string
          return acc;
        },
        {},
      );

      // map of AssetID: Balance
      return assetBalances;
    } catch (error) {
      this.logger.error(`Error fetching asset balances: ${error.message}`);
      throw error;
    }
  }

  async getAssetBalance(asset_id: SymbolAssetIdMapValue): Promise<string> {
    try {
      return await this.client.utxo.safeAssetBalance({ asset: asset_id });
    } catch (e) {
      this.logger.error(`Mixin getAssetBalance() => ${e.message}`);
      return '0';
    }
  }

  async checkMixinBalanceEnough(
    asset_id: SymbolAssetIdMapValue,
    amount: string,
  ): Promise<boolean> {
    try {
      const balance = await this.getAssetBalance(asset_id);
      if (BigNumber(balance).isLessThan(amount)) {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  private async handleSnapshot(snapshot: SafeSnapshot) {
    const exist = await this.snapshotsRepository.checkSnapshotExist(
      snapshot.snapshot_id,
    );
    if (exist) {
      return;
    }
    if (!snapshot.memo) {
      await this.createSnapshot(snapshot);
      this.logger.warn('snapshot no memo, return');
      return;
    }
    if (snapshot.memo.length === 0) {
      await this.createSnapshot(snapshot);
      this.logger.warn('snapshot.memo.length === 0, return');
      // await this.refund(snapshot);
      return;
    }

    const hexDecoedMemo = Buffer.from(snapshot.memo, 'hex').toString('utf-8');
    const decodedMemo = Buffer.from(hexDecoedMemo, 'base64').toString('utf-8');
    const tradingType = decodedMemo.slice(0, 2);
    switch (tradingType) {
      case 'SP':
        const spotDetails = decodeSpotMemo(decodedMemo);
        if (!spotDetails) {
          break;
        }
        let spotOrderCreateEvent = new SpotOrderCreateEvent();
        spotOrderCreateEvent = { ...spotDetails, snapshot };
        this.events.emit('spot.create', spotOrderCreateEvent);
        break;

      case 'AR':
        const arbDetails = decodeArbitrageMemo(decodedMemo);
        if (!arbDetails) {
          break;
        }
        this.events.emit('arbitrage.create', arbDetails, snapshot);
        break;

      case 'MM':
        const mmDetails = decodeMarketMakingMemo(decodedMemo);
        if (!mmDetails) {
          break;
        }
        this.events.emit('market_making.create', mmDetails, snapshot);
        break;

      default:
        // await this.refund(snapshot);
        break;
    }
    await this.createSnapshot(snapshot);
  }

  @Cron('*/5 * * * * *') // Every 5 seconds
  async handleSnapshots(): Promise<void> {
    // Check if the cron is enabled
    if (this.enableCron) {
      await this.fetchAndProcessSnapshots();
    } else {
      return;
    }
  }
}
