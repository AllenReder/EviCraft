package dev.mcagent.runtime.core.task.combat;

import dev.mcagent.runtime.core.Constants;
import dev.mcagent.runtime.core.FailureType;
import dev.mcagent.runtime.core.act.Ballistics;
import dev.mcagent.runtime.core.combat.AttackPlan;
import dev.mcagent.runtime.core.combat.Battlefield;
import dev.mcagent.runtime.core.combat.Loadout;
import dev.mcagent.runtime.core.combat.Menace;
import dev.mcagent.runtime.core.combat.Swing;
import dev.mcagent.runtime.core.pathing.calc.NavGoal;
import dev.mcagent.runtime.core.pathing.goals.GoalAvoidEntities;
import dev.mcagent.runtime.core.pathing.execute.PlayerNav;
import dev.mcagent.runtime.core.pathing.bridge.WorldKnowledgeContextProvider;
import dev.mcagent.runtime.core.task.base.AbstractBotTask;
import dev.mcagent.runtime.entity.InputDriver;
import dev.mcagent.runtime.entity.BotPlayer;
import dev.mcagent.runtime.task.TaskState;
import dev.mcagent.runtime.core.task.base.Precondition;
import dev.mcagent.runtime.bot.RuntimeBotManager;
import dev.mcagent.runtime.evidence.EntityTrack;
import dev.mcagent.runtime.core.task.interact.PhysicalVerificationAuthority;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * {@code attack}: defeat the given entities. <b>Melee or ranged is decided by the body, not by the model</b>.
 *
 * <h2>Why one combined tool</h2>
 * At dispatch time the model knows whom to attack. It does not know the distance when the Bot arrives, line
 * of sight, arrows left, or whether the target is reachable; these change every tick and only the body can
 * read them. Letting the model choose bow or sword would force a decision on stale information and add a
 * whole class of errors (ordering a ranged attack with no arrows in the inventory).
 *
 * <h2>Three weapon disciplines, one decision</h2>
 * Swinging (cooldown and invulnerability frames), shooting (ballistics and draw), and evasion (potential
 * field) are genuinely different; which one to use is decided in one place, {@link AttackPlan}, which the
 * reflex chain uses too.
 *
 * <h2>Explosives</h2>
 * A creeper <b>is an ordinary mob until its fuse is lit</b>: the Bot reaches 4 blocks and it ignites only at
 * 3, and the one-block band between lets the Bot hit it without triggering it. Backing off after ignition is
 * still in time: the fuse lasts 30 ticks, blast damage falls to zero at 6 blocks, and sprinting out from 3
 * blocks takes about ten ticks. End crystals are different: no fuse, they explode when hit. See
 * {@link Menace}.
 */
public final class AttackTask extends AbstractBotTask<AttackTaskRecord> {

    private static final double CHASE_SPEED = 1.2;
    // Ballistics constants: arrow physics and the launch speeds of both launchers.
    private static final double MAX_FIRING_RANGE = 32.0;
    private static final double ARROW_GRAVITY = 0.05;
    private static final double ARROW_DRAG = 0.99;
    private static final double ARROW_HITBOX_RADIUS = 0.5;
    private static final double BOW_FULL_SPEED = 3.0;
    private static final double CROSSBOW_SPEED = 3.15;
    /** Consecutive misfires after which the weapon is judged unusable. */
    private static final int MAX_MISFIRES = 2;
    /** Minimum distance to the target while shooting: closer, the trajectory is too flat and the Bot takes hits for nothing. */
    private static final double RANGED_MIN_DISTANCE = 5.0;
    /** Radius for assembling the situation: both whom the potential field avoids and whom indiscriminate mode attacks. */
    private static final double FIELD_RADIUS = 12.0;


    /**
     * Inner edge of the bow-combat ring: any closer and the bow cannot be drawn usefully; the trajectory is
     * flat and the Bot takes hits for nothing.
     *
     * <p>It <b>is</b> the bow discipline's "danger radius", in the same position as the sword's
     * {@code Menace.rawDangerRadius}, with a different value.
     *
     * <p>Eight blocks, not five: <b>a full bow draw takes twenty ticks</b>, during which a zombie walks four
     * and a half blocks. At five, the mob closes in while the bow is half drawn and the draw must be aborted
     * and restarted, leaving the Bot stuck at point-blank range. The inner edge must cover how far a foe can
     * move during one draw.
     */
    private static final double BOW_MIN_DISTANCE = 8.0;

    /**
     * Outer edge of the bow-combat ring. <b>Not the maximum range</b>: at thirty-two blocks the Bot could stand
     * far away, but arrows drop and targets move, so shots that far mostly miss. Twelve blocks hits reliably
     * while keeping distance: any farther and the Bot moves back in.
     */
    private static final double BOW_MAX_DISTANCE = 12.0;



    private Entity target;

    /**
     * Targets for which the last search <b>found no path</b>. Reachability is topological, not a matter of
     * distance: a skeleton three blocks away across a cliff is close but has no path, so only pathfinding can
     * tell.
     *
     * <p>Refreshed on every search: an entry is removed once a path is found. It is not a permanent verdict,
     * only the conclusion of the last search.
     */
    private final java.util.Set<Integer> noPath = new java.util.HashSet<>();

    private final List<dev.mcagent.runtime.evidence.EntityObservation> observedDrops = new java.util.ArrayList<>();

    /**
     * UUIDs handled in this fight. Indiscriminate mode has no list up front; without recording them, results
     * could not be settled, and everything it defeated would be dropped for "not being in the request list".
     */
    private final Set<UUID> authorizedUuids = new java.util.LinkedHashSet<>();
    private final Map<Integer, UUID> uuidByRuntimeId = new HashMap<>();
    private UUID reacquiringUuid;

    /** Last positioning log line. Not repeated while the numbers are unchanged, so one line per tick does not flood the log. */
    private String lastStandoffLog;

    private RangedShot shot;
    private int misfires;
    private int lastPlanLogTick = -1000;
    private AttackPlan.Action lastLoggedAction;
    /** The previous tick's decision, used for hysteresis and commitment; see {@link AttackPlan#decide}. */
    private AttackPlan.Move lastMove;


    public AttackTask(BotPlayer player, AttackTaskRecord record) {
        super(player, record);
    }

    @Override
    protected List<Precondition> preconditions() {
        return List.of(this::bindAuthorizedEvidence);
    }

    private Precondition.Failure bindAuthorizedEvidence() {
        if (r.indiscriminate) {
            admitVisibleHostiles();
            return null;
        }
        String dimension = dimension();
        for (UUID uuid : r.entityUuids) {
            EntityTrack track = evidence(uuid);
            if (track == null || !dimension.equals(track.dimension())
                    || uuid.equals(player.getUUID())
                    || "minecraft:item".equals(track.entityId())) {
                return new Precondition.Failure("entity UUID " + uuid
                        + " is unknown, expired, not attackable, or in another dimension",
                        FailureType.TARGET_LOST);
            }
            authorizedUuids.add(uuid);
        }
        return null;
    }

    @Override
    protected TaskState onTick() {
        if (player.isDeadOrDying()) return TaskState.CANCELLED;

        // Settle terminal states before any tactics: a finished fight needs no more footwork.
        settleFinishedTargets();
        if (authorizedUuids.stream().allMatch(r::terminal)) {
            return finish();
        }

        TaskState reacquiring = reacquireFrozenTargetIfNeeded();
        if (reacquiring != null) return reacquiring;

        Battlefield field = surveyField();
        AttackPlan.Move move = AttackPlan.decide(field, lastMove);
        lastMove = move;
        logMove(move, field);

        Entity chosen = move.foeId() == AttackPlan.NO_FOE ? null : liveEntity(move.foeId());
        if (chosen != target) {
            stopNav();
            abortShot();
            target = chosen;
        }
        // Attack and movement are <b>orthogonal</b>: every tick first ask "is the cooldown ready, is anyone in
        // reach", and strike if so, whether the Bot is closing in, backing off, or standing still. Attacking
        // does not affect pathfinding; at most it turns the Bot's head.
        tickShield();
        tickWeapon(field);
        return switch (move.action()) {
            case SKIRMISH -> {
                bowFighting = false;
                yield closeIn();
            }
            case BOW -> {
                bowFighting = true;
                yield bowFight();
            }
            case DONE -> finish();
        };
    }

    // ==================== Situation ====================

    /**
     * Folds this tick's world into a {@link Battlefield}.
     *
     * <p>The authorized list is frozen at task start; other currently visible hostiles only count as threats.
     */
    private Battlefield surveyField() {
        List<Battlefield.Foe> foes = new ArrayList<>();
        uuidByRuntimeId.clear();
        for (EntityTrack track : visibleTracks()) {
            boolean authorized = authorizedUuids.contains(track.uuid());
            if (!authorized && (player.position().distanceToSqr(track.position())
                    > FIELD_RADIUS * FIELD_RADIUS || !hostile(track))) continue;
            if (authorized && r.terminal(track.uuid())) continue;
            Entity e = visibleEntity(track);
            if (e == null) continue;
            uuidByRuntimeId.put(e.getId(), track.uuid());
            boolean engaging = e instanceof Mob mob
                    && (mob.getTarget() == player || mob == player.getLastHurtByMob());
            foes.add(new Battlefield.Foe(e.getId(), player.distanceTo(e),
                    Menace.explodes(e), Menace.armed(e), engaging,
                    reachable(e.getId()), authorized));
        }
        Loadout loadout = Loadout.forTarget(player, player);
        return new Battlefield(
                Menace.effectiveHealth(player),
                loadout.hasMelee(), loadout.hasRanged(), foes);
    }

    private boolean reachable(int id) {
        return !noPath.contains(id);
    }

    private Entity liveEntity(int id) {
        Entity e = ((ServerLevel) player.level()).getEntity(id);
        UUID authorized = uuidByRuntimeId.get(id);
        return e == null || e.isRemoved() || e == player || authorized == null
                || !authorized.equals(e.getUUID()) ? null : e;
    }

    private EntityTrack evidence(UUID uuid) {
        return RuntimeBotManager.knowledge(player.getServer()).entity(uuid).orElse(null);
    }

    private Entity visibleEntity(EntityTrack track) {
        if (track == null || track.state() != EntityTrack.State.VISIBLE
                || !dimension().equals(track.dimension())) return null;
        Entity entity = ((ServerLevel) player.level()).getEntity(track.uuid());
        return entity != null && !entity.isRemoved() && entity.getUUID().equals(track.uuid())
                && BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString()
                .equals(track.entityId()) ? entity : null;
    }

    private List<EntityTrack> visibleTracks(double radius) {
        double radiusSquared = radius * radius;
        return visibleTracks().stream()
                .filter(track -> player.position().distanceToSqr(track.position()) <= radiusSquared)
                .toList();
    }

    private List<EntityTrack> visibleTracks() {
        return RuntimeBotManager.knowledge(player.getServer()).entities().stream()
                .filter(track -> track.state() == EntityTrack.State.VISIBLE)
                .filter(track -> dimension().equals(track.dimension()))
                .toList();
    }

    private List<Mob> visibleHostileMobs(double radius) {
        List<Mob> mobs = new ArrayList<>();
        for (EntityTrack track : visibleTracks(radius)) {
            Entity entity = visibleEntity(track);
            if (hostile(track) && entity instanceof Mob mob) mobs.add(mob);
        }
        return mobs;
    }

    private boolean hostile(EntityTrack track) {
        return track.hostile();
    }

    private String dimension() {
        return player.level().dimension().location().toString();
    }

    private void admitVisibleHostiles() {
        for (EntityTrack track : dev.mcagent.runtime.knowledge.EntityKnowledgeSelection.selectTargets(
                allEvidence(), dimension(), null, null,
                player.position(), (double) FIELD_RADIUS)) {
            if (track.state() == EntityTrack.State.VISIBLE && hostile(track)) {
                authorizedUuids.add(track.uuid());
            }
        }
    }

    private List<EntityTrack> allEvidence() {
        return RuntimeBotManager.knowledge(player.getServer()).entities();
    }

    /** Navigate only to the frozen Track snapshot until the exact UUID is visible again. */
    private TaskState reacquireFrozenTargetIfNeeded() {
        boolean hasVisible = authorizedUuids.stream()
                .filter(uuid -> !r.terminal(uuid))
                .map(this::evidence)
                .anyMatch(track -> visibleEntity(track) != null);
        if (hasVisible) {
            reacquiringUuid = null;
            return null;
        }
        EntityTrack frozen = authorizedUuids.stream()
                .filter(uuid -> !r.terminal(uuid))
                .map(this::evidence)
                .filter(java.util.Objects::nonNull)
                .filter(track -> track.state() == EntityTrack.State.KNOWN)
                .findFirst().orElse(null);
        if (frozen == null) return null;
        target = null;
        abortShot();
        if (!frozen.uuid().equals(reacquiringUuid)) {
            stopNav();
            reacquiringUuid = frozen.uuid();
        }
        if (nav == null) {
            BlockPos snapshot = BlockPos.containing(frozen.position());
            nav = PlayerNav.toGoal(player,
                    () -> NavGoal.nearGround(snapshot, 2.0), CHASE_SPEED, () -> false);
        }
        PlayerNav.Status status = nav.tick();
        if (status == PlayerNav.Status.FAILED) {
            r.unreachable(frozen.uuid());
            stopNav();
            reacquiringUuid = null;
        } else if (status == PlayerNav.Status.ARRIVED) {
            stopNav();
        }
        return TaskState.RUNNING;
    }

    /** Records targets with an outcome (dead / gone) and collects attributed drops. */
    private void settleFinishedTargets() {
        for (UUID uuid : List.copyOf(authorizedUuids)) {
            if (r.terminal(uuid)) {
                continue;
            }
            RuntimeBotManager.AttributableDeath death = RuntimeBotManager
                    .consumeAttributableDeath(player.getServer(), uuid).orElse(null);
            if (death != null && dimension().equals(death.dimension())) {
                r.defeated(uuid);
                observedDrops.addAll(death.drops());
                continue;
            }
            EntityTrack track = evidence(uuid);
            if (track == null || !dimension().equals(track.dimension())) {
                // A struck target that vanished from the world without an attribution receipt counts as
                // defeated. Finishing deaths such as burning or falling do not take LivingDrops' player
                // attribution path, but they are still results of this fight; a non-combat loss should not
                // coincide with strikes>0.
                if (r.strikes(uuid) > 0) {
                    r.defeated(uuid);
                    continue;
                }
                // A dying entity (isDeadOrDying) still exists but is no longer in knowledge (a dying zombie
                // that was VISIBLE returns null): settle it as defeated on the tick a strike put it into the
                // dying state. Finishing burns are still recorded, instead of expiring as lost after the
                // 20-tick death animation.
                Entity dying = ((ServerLevel) player.level()).getEntity(uuid);
                if (dying instanceof LivingEntity living && living.isDeadOrDying()
                        && r.strikes(uuid) > 0) {
                    r.defeated(uuid);
                    continue;
                }
                r.lost(uuid);
            }
        }
    }

    /**
     * Judged once when the search finds no path: <b>if it can be shot, switch to the bow; with no trajectory
     * either, it is unsolvable</b> and this foe is dropped.
     *
     * <pre>
     * path                        → sword
     * no path + trajectory        → bow
     * no path + no trajectory     → give up on this foe (next one; finish if none remain)
     * </pre>
     *
     * <p>Sampled only once, when NO-PATH is final. That verdict comes from a search exhausting its whole
     * budget, so it is not noise; "no trajectory this tick" can be noise, so it never causes giving up on its
     * own. Both conditions must hold.
     */
    private void judgeNoPath(Entity foe) {
        noPath.add(foe.getId());
        if (Loadout.forTarget(player, foe).hasRanged() && shotExistsTo(foe)) {
            return;   // unreachable but shootable: the top level switches to the bow next tick
        }
        UUID uuid = uuidByRuntimeId.get(foe.getId());
        if (uuid != null) r.unreachable(uuid);
        Constants.LOG.info("[mc_agent-attack] give up target={} unreachable and no trajectory", foe.getId());
    }

    /** Whether an arrow trajectory that hits it can be computed now. A mob in a corner no arrow reaches is unsolvable. */
    private boolean shotExistsTo(Entity foe) {
        return arrowShot(foe, BOW_FULL_SPEED * RangedShot.bowPowerForTicks(15), true) != null;
    }

    private Ballistics.Aim arrowShot(Entity foe, double velocity, boolean copiesShooterVelocity) {
        Set<UUID> visible = visibleTracks().stream().map(EntityTrack::uuid)
                .collect(java.util.stream.Collectors.toSet());
        return Ballistics.findArrowShot(WorldKnowledgeContextProvider.executionView(player),
                player, foe, visible, velocity, ARROW_GRAVITY, ARROW_DRAG,
                ARROW_HITBOX_RADIUS, MAX_FIRING_RANGE, copiesShooterVelocity);
    }

    /** Done: the list is cleared (named mode), or nothing is chasing the Bot anymore (indiscriminate). */
    private TaskState finish() {
        InputDriver.halt(player);
        stopNav();
        if (authorizedUuids.stream().anyMatch(uuid -> !r.terminal(uuid))) {
            return TaskState.RUNNING;
        }
        if (r.indiscriminate || !r.defeated().isEmpty()) {
            succeed();
            return TaskState.SUCCESS;
        }
        fail("none of the requested entity UUIDs could be attacked", FailureType.TARGET_LOST);
        return TaskState.FAILED;
    }

    private void logMove(AttackPlan.Move move, Battlefield field) {
        if (move.action() == lastLoggedAction && player.tickCount - lastPlanLogTick < 40) return;
        lastLoggedAction = move.action();
        lastPlanLogTick = player.tickCount;
        Constants.LOG.info("[mc_agent-attack] {} foe={} dist={} melee={} ranged={} hp_eff={} field={}",
                move.action(),
                move.foeId() == AttackPlan.NO_FOE ? "all" : move.foeId(),
                move.foeId() == AttackPlan.NO_FOE ? "-"
                        : String.format("%.1f", distanceOf(field, move.foeId())),
                field.hasMelee(), field.hasRanged(),
                String.format("%.0f", field.effectiveHealth()), field.foes().size());
    }

    private static double distanceOf(Battlefield field, int id) {
        var f = field.byId(id);
        return f == null ? -1 : f.distance();
    }

    // ==================== Melee ====================

    /**
     * Shield. A <b>third layer</b> alongside attack and pathing, likewise asked every tick and likewise
     * independent of what the others are doing.
     *
     * <pre>
     * in bow combat                                     → leave it (drawing and blocking compete for the
     *                                                     same useItem, a hard vanilla constraint)
     * someone inside its danger radius and shield usable → raise
     * otherwise                                         → lower
     * </pre>
     *
     * <p>The attack cooldown is ignored: vanilla allows swinging while blocking, so the two do not conflict.
     * The attack layer is not blocked either, which would couple the layers again. Blocking slows the Bot;
     * that cost is accepted, since a blocked hit is worth more than backing off half a block sooner. A shield
     * broken by an axe goes on cooldown, and the Bot then moves normally.
     *
     * <p>The shield is not lowered when the attack cooldown is ready: since the Bot can swing while blocking,
     * that step would be redundant.
     */
    private void tickShield() {
        if (bowFighting) {
            return;
        }
        boolean raised = shieldRaised();
        boolean threatened = false;
        for (var mob : visibleHostileMobs(FIELD_RADIUS)) {
            if (Menace.tooClose(mob, player)) {
                threatened = true;
                break;
            }
        }
        if (!threatened) {
            if (raised) {
                player.releaseUsingItem();
            }
            return;
        }
        if (raised || player.isUsingItem()) {
            return;   // already raised, or the hands are busy with something else
        }
        ItemStack shield = player.getOffhandItem().is(Items.SHIELD)
                ? player.getOffhandItem() : equipShield();
        if (shield.isEmpty() || player.getCooldowns().isOnCooldown(shield.getItem())) {
            return;   // no shield, or broken by an axe and still on cooldown: move normally
        }
        player.startUsingItem(InteractionHand.OFF_HAND);
    }

    private boolean shieldRaised() {
        return player.isUsingItem()
                && player.getUsedItemHand() == InteractionHand.OFF_HAND
                && player.getUseItem().is(Items.SHIELD);
    }

    /**
     * If the offhand is empty, equips a shield from the inventory: <b>the sword is switched to automatically,
     * and so is the shield</b>.
     *
     * <p>Only when the offhand is <b>empty</b>: the offhand may hold something on purpose, and the Bot should
     * not replace it.
     */
    private ItemStack equipShield() {
        if (!player.getOffhandItem().isEmpty()) {
            return ItemStack.EMPTY;
        }
        var inventory = player.getInventory();
        for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
            ItemStack stack = inventory.getItem(slot);
            if (stack.is(Items.SHIELD)) {
                ItemStack shield = stack.split(1);
                player.setItemSlot(net.minecraft.world.entity.EquipmentSlot.OFFHAND, shield);
                player.inventoryMenu.broadcastChanges();
                return shield;
            }
        }
        return ItemStack.EMPTY;
    }

    /**
     * Attack system. <b>Orthogonal to movement</b>: every tick ask "is the cooldown ready, is anyone in reach",
     * and swing if so, regardless of whether the Bot is closing in, backing off, or standing still, and
     * without changing where it is going.
     *
     * <p>The victim is <b>chosen here</b>, not taken from the decision's {@code move.foeId()}: a field-wide move
     * has no single foe and the task's {@code target} is null, which would leave the sword unused and the Bot
     * not hitting back while evading.
     *
     * @param field this tick's situation, reusing the one onTick already surveyed
     */
    private void tickWeapon(Battlefield field) {
        if (player.isUsingItem() && !shieldRaised()) {
            return;   // drawing a bow or eating: do not interrupt
        }
        // <b>Swinging while blocking is allowed</b>; vanilla has no conflict there. The guard above targets
        // "drawing a bow", not "using any item": treating a raised shield as busy would lock the attack layer
        // entirely, leaving the Bot inside the band without ever swinging.
        // A weapon is <b>optional</b>: a fist deals one damage, and a chicken (4 HP), sheep (8 HP), or cow
        // (10 HP) can still be beaten. Requiring a melee weapon would make the Bot walk up to a harmless target
        // the model named and stand there doing nothing.
        Loadout loadout = Loadout.forTarget(player, player);
        Entity victim = null;
        double best = Double.MAX_VALUE;
        for (var f : field.foes()) {
            if (!f.authorized()) continue;
            if (f.armed() || f.distance() >= best) {
                continue;   // never hit one with a lit fuse: that would set it off
            }
            Entity e = liveEntity(f.id());
            if (e != null && f.distance() <= Swing.reachTo(
                    player.getAttributeValue(Attributes.ENTITY_INTERACTION_RANGE), e.getBbWidth())) {
                victim = e;
                best = f.distance();
            }
        }
        if (victim == null) {
            return;
        }
        ItemStack before = player.getMainHandItem();
        if (loadout.hasMelee()) {
            player.holdInHand(loadout.melee().slot());
        }
        boolean weaponChanged = player.getMainHandItem() != before;
        if (!Swing.mayStrike(weaponChanged, victim instanceof LivingEntity hurt && hurt.hurtTime > 0,
                player.getAttackStrengthScale(0.0f))) {
            return;
        }
        UUID boundUuid = uuidByRuntimeId.get(victim.getId());
        EntityTrack boundTrack = boundUuid == null ? null : evidence(boundUuid);
        if (boundTrack == null || !PhysicalVerificationAuthority.attackEntity(player,
                new PhysicalVerificationAuthority.BoundEntity(boundUuid, boundTrack),
                player.getAttributeValue(Attributes.ENTITY_INTERACTION_RANGE))) {
            return;
        }
        UUID uuid = boundUuid;
        if (uuid != null) {
            r.strike(uuid);
        }
    }

    /**
     * Bow combat: <b>the same footwork as sword combat</b>, with a different ring (inner edge
     * {@link #BOW_MIN_DISTANCE}, outer edge the firing range). Inside the band the navigation arrives on its
     * own and the Bot stops, and only then draws; "when to stand still" needs no separate logic.
     */
    private TaskState closeIn() {
        driveApproach();
        return TaskState.RUNNING;
    }

    private TaskState bowFight() {
        // <b>Both layers run in parallel</b>: the feet keep doing footwork while the hands keep drawing. Vanilla
        // allows walking while drawing (only slower); halting in shootAt would build and tear down navigation
        // every tick.
        driveApproach();
        return shootAt(Loadout.forTarget(player, target));
    }




    /**
     * Footwork: stay at a distance where the target is in reach, while keeping away from other hostiles.
     *
     * <p>Striking and approaching share this path: they differ only in whether to swing, and the positioning
     * is the same. Separate paths would discard the freshly computed path on every stance change, and
     * knockback changes the stance with every hit.
     */
    private PlayerNav.Status driveApproach() {
        if (nav == null) {
            // <b>Move even without a target.</b> The decision's SKIRMISH can be field-wide (nothing hittable,
            // but something is still chasing the Bot), and then the Bot should back off and wait for an
            // opening. Do not return early on {@code target == null}: the decision would keep saying
            // "footwork" while the execution layer silently does nothing. standoffGoal decides when no
            // movement is needed (it returns null once the field is empty).
            //
            // Targets move: use trackGoal, not toGoal. The latter stays ARRIVED forever once reached, so the
            // Bot would stand still and stop following, letting other mobs close in unopposed.
            nav = PlayerNav.trackGoal(player, this::standoffGoal, CHASE_SPEED, () -> false);
        }
        PlayerNav.Status status = nav.tick();
        // <b>Only a real NO-PATH means unreachable</b>: the search exhausted its whole budget without a route.
        // A lost target, being boxed in, or replanning jitter are different matters; treating them as
        // unreachable would write off an ordinary zombie two blocks away.
        boolean noRoute = status == PlayerNav.Status.FAILED
                && nav.failType() == FailureType.NO_PATH;
        if (status == PlayerNav.Status.FAILED) {
            stopNav();
        }
        // The bow ring spans 8-12 blocks and asks a different question than the melee ring; its outcome says
        // nothing about reachability.
        if (target != null && !bowFighting) {
            if (noRoute) {
                judgeNoPath(target);
            } else {
                noPath.remove(target.getId());
            }
        }
        return status;
    }

    /**
     * The center distance at which the Bot can reach the current target. Without a target, falls back to the
     * Bot's own reach.
     *
     * <p>A large slime is 2.04 wide, so its half-width alone exceeds one block; a flat 3.0 would judge it out of
     * reach although a vanilla player can hit it. The decision's reach and the positioning's attraction
     * radius must be this same number.
     */
    /** Whether this tick uses bow combat. The ring's inner and outer edges, and what the attack layer uses, depend on it. */
    private boolean bowFighting;

    /** Outer edge of the footwork ring: the reach for a sword, {@link #BOW_MAX_DISTANCE} for a bow. */
    private double skirmishOuter() {
        if (!bowFighting) return reachToTarget();
        return target != null && Menace.armed(target)
                ? skirmishInner() + (BOW_MAX_DISTANCE - BOW_MIN_DISTANCE)
                : BOW_MAX_DISTANCE;
    }

    /** Inner edge of the footwork ring: "it can reach me" for a sword, "far enough to draw" for a bow. */
    private double skirmishInner() {
        if (!bowFighting) {
            return target == null ? 0.0 : Menace.rawDangerRadius(target, player);
        }
        return target != null && Menace.armed(target)
                ? Math.max(BOW_MIN_DISTANCE, Menace.dangerRadius(target, player))
                : BOW_MIN_DISTANCE;
    }

    private double reachToTarget() {
        double native0 = player.getAttributeValue(Attributes.ENTITY_INTERACTION_RANGE);
        return target == null || target.isRemoved()
                ? Swing.reachOf(native0)
                : Swing.reachTo(native0, target.getBbWidth());
    }

    /**
     * Combat positioning: go where the target is in reach, <b>with the cell underfoot outside every foe's
     * danger radius</b>.
     *
     * <h2>Why arrival checks the danger radius</h2>
     * If arrival only asked "in reach?", the Bot would arrive as soon as it entered the target's spherical
     * neighborhood, and <b>once arrived, A* stops searching</b>, so the potential-field heuristic is never
     * used: a zombie shuffles closer, the Bot's cell still qualifies, and it neither replans nor evades. That
     * is how evading explosions can work while surprise attacks still land.
     *
     * <p>This alone is not enough: the goal is a <b>snapshot</b> from when the path was planned. The real
     * per-tick re-check is on the decision side; this only keeps the chosen foothold out of a foe's reach.
     *
     * <h2>The target itself is in the potential field</h2>
     * It attacks the Bot too, so no separate inner edge is needed: the attraction term pulls the Bot into
     * reach, its own danger radius holds the Bot outside its reach, and the gap between is where the two
     * balance. The gap width comes from vanilla hitboxes: 3.30 vs. 2.73 for a zombie, just over half a block.
     *
     * <h2>When surrounded</h2>
     * No qualifying cell does not mean failure: the engine's seven-tier {@code bestSoFar} yields the best
     * segment found in this search.
     */
    private NavGoal standoffGoal() {
        var field = visibleHostileMobs(FIELD_RADIUS);
        if (field.isEmpty() && (target == null || target.isRemoved())) {
            return null;
        }
        logStandoff(field);
        if (target == null || target.isRemoved()) {
            // <b>Keep the footwork even without a target</b>: the ring reduces to "outside every foe's danger
            // radius". This branch handles a field with only a lit creeper left (unhittable without a bow):
            // back off and wait for the fuse to go out instead of fleeing far.
            return NavGoal.avoid(Menace.AVOID_PENALTY, Menace.field(player, field));
        }
        // Footwork is <b>a ring</b>: the outer edge keeps the target in range, and the inner edge keeps the Bot
        // out of every foe's reach. Too close moves outward and too far moves back on its own; backing off is
        // not a separate action.
        //
        // The outer edge <b>is the Bot's reach</b>. Pathfinding does not strike, but it must bring the Bot
        // within striking range, or the attack layer never gets a chance: with a wider outer edge (e.g. 4.73)
        // the Bot would stop "in position" at 4.7 while its reach is only 3.30, and stand there taking hits.
        //
        // The inner edge uses the <b>raw</b> attack distance (2.02), without cell slack. The band is then 1.28
        // blocks wide, comfortably wider than the 0.71 cell-quantization error; adding the slack to the inner
        // edge as well would shrink the band to 0.57 blocks, too narrow to work.
        var threats = combatThreats(field);
        return NavGoal.approachAvoiding(
                NavGoal.ring(target.blockPosition(), skirmishInner(), skirmishOuter()),
                Menace.AVOID_PENALTY,
                bowFighting
                        ? Menace.field(player, threats).stream()
                                .map(x -> x.withClearance(
                                        Math.max(x.clearance(), BOW_MIN_DISTANCE)))
                                .toList()
                        : Menace.field(player, threats));
        // The bow inner edge applies to <b>every</b> foe: the Bot keeps its distance from all mobs, not only the
        // current target.
    }

    /** Include an exact visible explosive target even when it is not a {@link Mob}. */
    private List<Entity> combatThreats(List<Mob> hostileMobs) {
        List<Entity> threats = new ArrayList<>(hostileMobs);
        if (target != null && !target.isRemoved() && Menace.explodes(target)
                && !threats.contains(target)) {
            threats.add(target);
        }
        return threats;
    }

    /** Logs positioning only when the numbers actually change; one line per tick would flood everything else. */
    private void logStandoff(List<Mob> field) {
        int tooClose = 0;
        for (var mob : field) {
            if (Menace.tooClose(mob, player)) {
                tooClose++;
            }
        }
        String line = target == null || target.isRemoved()
                ? String.format("no target (retreat only) too_close=%d field=%d", tooClose, field.size())
                : String.format("%s target=%d dist=%.1f band=[%.2f, %.2f] too_close=%d field=%d",
                        bowFighting ? "bow" : "sword", target.getId(), player.distanceTo(target),
                        skirmishInner(), skirmishOuter(), tooClose, field.size());
        if (!line.equals(lastStandoffLog)) {
            lastStandoffLog = line;
            Constants.LOG.info("[mc_agent-attack] standoff {}", line);
        }
    }

    // ==================== Ranged ====================

    private TaskState shootAt(Loadout loadout) {
        Loadout.Pick weapon = loadout.ranged();
        if (weapon == null) {
            return closeIn();   // bow gone: return to footwork, do not give up on this foe
        }
        // <b>The attack layer ignores distance.</b> Within range it shoots; backing off is pathfinding's job
        // (the ring's inner edge BOW_MIN_DISTANCE).
        //
        // Do not abort the shot when closer than the inner edge: a zombie stepping inside eight blocks would
        // cancel a half-drawn bow, the Bot backs off and redraws, the zombie follows, and no arrow is ever
        // released. Distance is a footwork criterion; mixed into the attack layer it becomes a switch that
        // keeps interrupting itself.
        if (player.distanceTo(target) > skirmishOuter()) {
            return TaskState.RUNNING;   // out of range: do not release, but <b>do not cancel</b> either; keep drawing
        }
        if (Menace.armed(target)
                && player.distanceTo(target) < Menace.rawDangerRadius(target, player)) {
            return TaskState.RUNNING;   // explodes when hit: keep drawing while backing off; release once outside the native blast damage range
        }
        boolean crossbow = RangedShot.isCrossbow(weapon);
        Ballistics.Aim aim = arrowShot(target, shotVelocity(crossbow), !crossbow);
        if (aim == null) {
            // No trajectory this tick. <b>Keep drawing</b>: the feet keep moving, so a window will open as the
            // position changes, and cancelling would waste a full draw.
            return TaskState.RUNNING;
        }

        // <b>Do not stop the feet.</b> The attack and pathing layers are orthogonal: swinging does not stop
        // movement, and neither should drawing, since vanilla allows walking while drawing. Calling stopNav() +
        // halt() here would tear down the navigation bowFight just built with driveApproach(), every tick, and
        // the bow would never reach full draw.
        // <b>Turn only just before release.</b> A vanilla arrow's direction depends only on the line of sight
        // at release, so aiming during the dozen or so draw ticks makes no difference, while turning every tick
        // skews the feet (movement is projected along the facing) and walks the Bot into the target. Melee
        // swings work the same way.
        if (shot != null && shot.aboutToRelease()) {
            InputDriver.lookAt(player, aim.lookPoint());
        }

        ItemStack before = player.getMainHandItem();
        player.holdInHand(weapon.slot());
        if (player.getMainHandItem() != before && shot == null) {
            return TaskState.RUNNING;   // swap only this tick; start drawing next tick
        }
        if (!RangedShot.stillHolding(crossbow, player.getMainHandItem())) {
            abortShot();
            return TaskState.RUNNING;
        }
        if (player.isUsingItem() && shot == null) {
            return TaskState.RUNNING;
        }
        if (shot == null) {
            shot = new RangedShot(player, crossbow);
        }
        if (shot.tick(aim, target)) {
            boolean fired = shot.fired();
            shot = null;
            if (fired) {
                UUID uuid = uuidByRuntimeId.get(target.getId());
                if (uuid != null) r.strike(uuid);
                misfires = 0;
            } else if (++misfires >= MAX_MISFIRES) {
                fail("the bow or crossbow did not launch an arrow", FailureType.WRONG_TOOL);
                return TaskState.FAILED;
            }
        }
        return TaskState.RUNNING;
    }

    private double shotVelocity(boolean crossbow) {
        return shot != null ? shot.projectileVelocity(BOW_FULL_SPEED, CROSSBOW_SPEED)
                : crossbow ? CROSSBOW_SPEED : BOW_FULL_SPEED * RangedShot.bowPowerForTicks(15);
    }

    // ==================== Cleanup and result ====================

    private void abortShot() {
        if (shot != null) {
            shot.abort();
            shot = null;
        }
    }

    @Override
    protected void cleanup() {
        abortShot();
        InputDriver.halt(player);
        player.setShiftKeyDown(false);
        super.cleanup();
    }

    @Override
    protected Map<String, Object> resultData() {
        Set<UUID> accounted = new java.util.LinkedHashSet<>(r.entityUuids);
        accounted.addAll(authorizedUuids);
        accounted.addAll(r.defeated());
        accounted.addAll(r.lost());
        accounted.addAll(r.unreachable());
        Map<String, Object> byEntity = new LinkedHashMap<>();
        for (UUID uuid : accounted) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("status", r.status(uuid));
            entry.put("strikes", r.strikes(uuid));
            byEntity.put(uuid.toString(), entry);
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("mode", r.indiscriminate ? "visible_hostiles" : "explicit_uuids");
        data.put("requested_uuids", r.entityUuids.stream().map(UUID::toString).toList());
        data.put("completion", completion());
        data.put("defeated_uuids", r.defeated().stream().map(UUID::toString).toList());
        data.put("lost_uuids", r.lost().stream().map(UUID::toString).toList());
        data.put("unreachable_uuids", r.unreachable().stream().map(UUID::toString).toList());
        data.put("strikes", r.strikes());
        data.put("combat_by_entity", byEntity);
        data.put("observed_drop_entities", observedDrops.stream()
                .map(drop -> {
                    Map<String, Object> entry = new LinkedHashMap<String, Object>();
                    entry.put("uuid", drop.uuid().toString());
                    entry.put("item_id", drop.itemId());
                    entry.put("count", drop.itemCount());
                    return entry;
                }).toList());
        if (lastFailure() == FailureType.TARGET_LOST) {
            data.put("failure_type", "target_lost");
        } else if (lastFailure() == FailureType.NO_PATH) {
            data.put("failure_type", "unreachable");
        }
        return data;
    }

    private String completion() {
        if (r.defeated().isEmpty()) return "none";
        long pending = authorizedUuids.stream().filter(uuid -> !r.terminal(uuid)).count();
        return pending == 0 ? "all" : "partial";
    }

    private String tally() {
        return r.indiscriminate
                ? r.defeated().size() + " hostiles"
                : r.defeated().size() + "/" + r.entityUuids.size() + " requested entities";
    }

    @Override
    protected String successMessage() {
        if (r.indiscriminate) {
            return "fought off " + tally();
        }
        int incomplete = r.lost().size() + r.unreachable().size();
        return "defeated " + tally()
                + (incomplete == 0 ? "" : " (" + incomplete + " targets could not be completed)");
    }

    @Override
    protected String timeoutMessage() {
        return "attack timed out after defeating " + tally();
    }

    @Override
    protected String cancelledMessage() {
        return "attack interrupted after defeating " + tally();
    }
}
