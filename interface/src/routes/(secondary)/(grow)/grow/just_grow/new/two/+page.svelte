<script lang="ts">
  import Amount from "$lib/components/grow/justGrow/new/amount.svelte";
  import Info from "$lib/components/grow/justGrow/new/info.svelte";
  import Intro from "$lib/components/grow/justGrow/new/createIntro.svelte";
  // import LockTime from "$lib/components/grow/justGrow/new/time.svelte";
  import Web3Address from "$lib/components/common/web3Address.svelte";
</script>

<div class="flex flex-col space-y-8">
  <Info />
  <div class="flex flex-col space-y-4">
    <Amount />
    <!-- <LockTime /> -->
  </div>
  <Web3Address />
  <div class="!mt-10">
    <Intro />
  </div>
</div>