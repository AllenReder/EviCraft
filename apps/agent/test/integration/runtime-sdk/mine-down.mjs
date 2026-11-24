export async function runMineDownSmoke({
  runtime,
  client,
  fixtureX,
  fixtureY,
  fixtureZ,
  command,
  assertBodyNear,
  AbilityRuntime,
  RuntimeAdapter,
  abilities,
  delay,
}) {
  console.log("smoke: live mine_down uses embodied feet and clears bounded descent geometry");
  const abilityRuntime = new AbilityRuntime();
  for (const definition of abilities) await abilityRuntime.register(definition);
  const context = {
    runtime: new RuntimeAdapter(client),
    services: {
      async wait(seconds, signal) {
        await delay(seconds * 1_000, undefined, { signal });
      },
    },
  };
  const staircase = { x: fixtureX + 8, y: fixtureY, z: fixtureZ + 8 };
  await command(
    `fill ${staircase.x - 2} ${staircase.y - 2} ${staircase.z - 3} ${staircase.x + 2} ${staircase.y + 3} ${staircase.z + 2} air`);
  await command(
    `fill ${staircase.x - 2} ${staircase.y - 2} ${staircase.z - 3} ${staircase.x + 2} ${staircase.y - 2} ${staircase.z + 2} stone`);
  await command(`setblock ${staircase.x} ${staircase.y - 1} ${staircase.z} stone`);
  await command(
    `fill ${staircase.x} ${staircase.y - 1} ${staircase.z - 1} ${staircase.x} ${staircase.y + 1} ${staircase.z - 1} stone`);
  await command(
    `fill ${staircase.x - 1} ${staircase.y - 1} ${staircase.z - 2} ${staircase.x + 1} ${staircase.y + 1} ${staircase.z - 2} stone`);
  // The body saw this space while it was air, and from the start position the lowest cell of the step is
  // hidden behind the other stone. Grounded evidence would keep it as air and mine_down would rightly skip
  // it, so let the body see that cell from the side first.
  const lowestStepCell = { x: staircase.x, y: staircase.y - 1, z: staircase.z - 1 };
  await command(`tp bot ${staircase.x - 1.5} ${staircase.y - 1} ${staircase.z - 0.5} -90 0`);
  const stepDimension = (await client.toolCall("get_self_status", {})).data?.dimension;
  let stepEvidence;
  const stepDeadline = Date.now() + 15_000;
  while (Date.now() < stepDeadline) {
    await client.observe();
    stepEvidence = await client.blockGet(stepDimension, [lowestStepCell]);
    if (stepEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
    await delay(50);
  }
  if (stepEvidence?.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`north step cell was not observed: ${JSON.stringify(stepEvidence)}`);
  }
  await command(`tp bot ${staircase.x + 0.5} ${staircase.y} ${staircase.z + 0.5} 180 0`);
  await command("item replace entity bot weapon.mainhand with minecraft:diamond_pickaxe 1");
  await client.observe();
  const staircaseResult = await abilityRuntime.dispatch("mine_down", {
    depth: 1,
    direction: "north",
  }, context);
  const staircaseAir = [];
  for (const y of [staircase.y + 1, staircase.y, staircase.y - 1]) {
    staircaseAir.push(await command(
      `execute if block ${staircase.x} ${y} ${staircase.z - 1} air`));
  }
  // The Ability's own account comes first: when it stopped early, its result says why.
  if (!staircaseResult.ok || staircaseResult.data?.completed_depth !== 1
      || staircaseResult.data?.broken?.length !== 3
      || staircaseAir.some((result) => !result.includes("Test passed"))) {
    throw new Error(`north mine_down did not clear one three-cell descent step: ${JSON.stringify({
      staircaseResult, staircaseAir,
    })}`);
  }
  await assertBodyNear(client, {
    x: staircase.x + 0.5,
    y: staircase.y - 1,
    z: staircase.z - 0.5,
  }, "north mine_down", 0.75);

  const vertical = { x: fixtureX + 12, y: fixtureY, z: fixtureZ + 8 };
  await command(
    `fill ${vertical.x - 1} ${vertical.y - 2} ${vertical.z - 1} ${vertical.x + 1} ${vertical.y - 2} ${vertical.z + 1} stone`);
  await command(
    `fill ${vertical.x - 1} ${vertical.y - 1} ${vertical.z - 1} ${vertical.x + 1} ${vertical.y + 2} ${vertical.z + 1} air`);
  // Grounded evidence keeps whatever it last saw under the pillar once the pillar hides it, and
  // earlier fixtures left this column remembered as air. Let the body see the new floor first;
  // otherwise mine_down rightly refuses a drop it believes is deeper than its limit.
  const shaftFloor = { x: vertical.x, y: vertical.y - 2, z: vertical.z };
  await command(`tp bot ${vertical.x + 0.5} ${vertical.y - 1} ${vertical.z + 1.5} 180 60`);
  const status = await client.toolCall("get_self_status", {});
  const dimension = status.data?.dimension;
  let floorEvidence;
  const floorDeadline = Date.now() + 15_000;
  while (Date.now() < floorDeadline) {
    await client.observe();
    floorEvidence = await client.blockGet(dimension, [shaftFloor]);
    if (floorEvidence.cells[0]?.state === "KNOWN_BLOCK") break;
    await delay(50);
  }
  if (floorEvidence?.cells[0]?.state !== "KNOWN_BLOCK") {
    throw new Error(`explicit-down shaft floor was not observed: ${JSON.stringify(floorEvidence)}`);
  }
  await command(`setblock ${vertical.x} ${vertical.y - 1} ${vertical.z} stone`);
  await command(`tp bot ${vertical.x + 0.5} ${vertical.y} ${vertical.z + 0.5} 180 0`);
  await client.observe();
  const verticalResult = await abilityRuntime.dispatch("mine_down", {
    depth: 1,
    direction: "down",
  }, context);
  const verticalAir = await command(
    `execute if block ${vertical.x} ${vertical.y - 1} ${vertical.z} air`);
  await assertBodyNear(client, {
    x: vertical.x + 0.5,
    y: vertical.y - 1,
    z: vertical.z + 0.5,
  }, "explicit-down mine_down", 0.75);
  if (!verticalResult.ok || verticalResult.data?.completed_depth !== 1
      || verticalResult.data?.broken?.length !== 1
      || !verticalAir.includes("Test passed")) {
    throw new Error(`default-down mine_down did not clear one vertical descent step: ${JSON.stringify({
      verticalResult, verticalAir,
    })}`);
  }
  await command("clear bot");
}
