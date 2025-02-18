import { page } from "$app/stores";
import { derived } from 'svelte/store';
import { growPathChecker } from "$lib/helpers/helpers";
import { writable, type Writable } from "svelte/store";

// 0 easy, 1 advanced
export const easyAdvancedMode = writable(0)

export const mmCoin0 = writable()
export const mmCoin1 = writable()
// 0 asset, 1 amount
export const mmEasyStep = writable(0)
export const addMoreDialog = writable(false)

export const currentArbitrageStatus = writable()
export const currentMarketMakingStatus = writable()

// Create new arbitrage
export const createArbConfirmDialog = writable(false)
export const editArbitrageDialog = writable(false)
export const selectArbExchange1Dialog = writable(false)
export const selectArbExchange2Dialog = writable(false)
export const selectArbPairDialog = writable(false)
export const createArbExchange1: Writable<string> = writable()
export const createArbExchange2: Writable<string> = writable()
export const createArbExchange1Search = writable('')
export const createArbExchange2Search = writable('')
export const createArbPair: Writable<string>= writable('')
export const createArbPairSearch: Writable<string>= writable('')
export const createArbAmount = writable([])


// Create new market making
export const createMMConfirmDialog = writable(false)
export const editMarketMakingDialog = writable(false)
export const createMMEasyPair = writable({ symbol:'BTC/USDT', exchange:'okx' })
export const createMMEasyAmounts = writable([])
export const createMMSelectPairEasyFilter = writable('')
export const createMMSelectPairEasySearch = writable('')

// Create new just grow
export const createJustGrowAsset = writable({ symbol:'BTC', name: 'Bitcoin', icon: 'https://mixin.one' })
export const createJustGrowAmount = writable()
export const createJustGrowLockTime = writable({ key: '', value: '' })
export const createJustGrowLockTimeDialog = writable(false)
export const createJustGrowConfirmDialog = writable(false)
export const createJustGrowSearch = writable('')
export const createJustGrowRewardAddressDialog = writable(false)
export const createJustGrowRewardAddress = writable('')

// Create new auto invest
export const createAISelectAssetSearch = writable("")
// 0 = select asset, 1 == amount and period, 2 == name and auto
export const createAIStep = writable(0)
export const createAIAssets = writable([])
export const createAIAmounts = writable([])
// from 60 minutes to 12 months, base: 1 hour, default: 24 hour
export const createAIPeriod = writable(24)
export const createAIName = writable('')
export const createAIFiat = writable('USDT')
export const createAIAutoPay = writable(true)
export const createAIPeriodDialog = writable(false)
export const createAISelectUnitDialog = writable(false)

export const isArbitragePage = derived(page, $page => growPathChecker($page, 'arbitrage'));
export const isMarketMakingPage = derived(page, $page => growPathChecker($page, 'market_making'));
export const isJustGrowPage = derived(page, $page => growPathChecker($page, 'just_grow'))