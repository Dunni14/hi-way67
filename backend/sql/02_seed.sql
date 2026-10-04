-- Driver safety app: seed data for config tables
-- Run after 01_schema.sql. Safe to re-run (upserts).

-- ---------------------------------------------------------------------
-- risk_factors: weight is computed as ln(odds_ratio)
-- ---------------------------------------------------------------------
INSERT INTO risk_factors (factor, odds_ratio, sub_score, source, verified) VALUES
  ('agitated',   9.8,  'reckless', 'Dingus et al. 2016, PNAS (SHRP 2): observable anger, sadness, agitation', true),
  ('speeding',   12.8, 'reckless', 'Dingus et al. 2016, PNAS (SHRP 2): speeding over limit / too fast for conditions. Contested as inflated (Young).', true),
  ('drowsy',     3.4,  'drowsy',   'Dingus et al. 2016, PNAS (SHRP 2): drowsiness/fatigue. Value from memory, check paper.', false),
  ('phone',      3.6,  'reckless', 'Dingus et al. 2016, PNAS (SHRP 2): handheld cell phone use, overall', true),
  ('distracted', 2.0,  'reckless', 'Dingus et al. 2016, PNAS (SHRP 2): observable distraction, overall', true),
  ('erratic',    2.0,  'reckless', 'Placeholder, hand-set. No study behind this value.', false)
ON CONFLICT (factor) DO UPDATE
  SET odds_ratio = EXCLUDED.odds_ratio, sub_score = EXCLUDED.sub_score,
      source = EXCLUDED.source, verified = EXCLUDED.verified;

-- ---------------------------------------------------------------------
-- sleep_terms: hours slept in last 24 h
-- ---------------------------------------------------------------------
INSERT INTO sleep_terms (min_hours, max_hours, odds_ratio, source) VALUES
  (0, 4,    11.5, 'Tefft 2016, AAA Foundation for Traffic Safety'),
  (4, 5,    4.3,  'Tefft 2016, AAA Foundation for Traffic Safety'),
  (5, 6,    1.9,  'Tefft 2016, AAA Foundation for Traffic Safety'),
  (6, 7,    1.3,  'Tefft 2016, AAA Foundation for Traffic Safety'),
  (7, NULL, 1.0,  'Reference group')
ON CONFLICT (min_hours) DO UPDATE
  SET max_hours = EXCLUDED.max_hours, odds_ratio = EXCLUDED.odds_ratio, source = EXCLUDED.source;

-- ---------------------------------------------------------------------
-- level_components: hand-set starting values, no study behind them
-- contribution = sub_weight * clamp(transform(signal) / scale, 0, 1)
-- ---------------------------------------------------------------------
INSERT INTO level_components (level, signal, sub_weight, scale, transform) VALUES
  ('drowsy',     'eye_closure_frac', 0.40, 0.30, 'raw'),
  ('drowsy',     'yawns',            0.20, 3,    'raw'),
  ('drowsy',     'engagement',       0.20, 1,    'one_minus'),
  ('drowsy',     'breathing_rate',   0.20, 4,    'below_baseline'),
  ('agitated',   'emotion_stress',   0.60, 1,    'raw'),
  ('agitated',   'heart_rate',       0.40, 25,   'above_baseline'),
  ('speeding',   'speed_mph',        1.00, 20,   'over_limit'),
  ('phone',      'phone_in_hand',    1.00, 1,    'boolean'),
  ('distracted', 'gaze_off_road_s',  1.00, 4,    'raw'),
  ('erratic',    'hard_brakes+swerves', 1.00, 3, 'sum_events')
ON CONFLICT (level, signal) DO UPDATE
  SET sub_weight = EXCLUDED.sub_weight, scale = EXCLUDED.scale, transform = EXCLUDED.transform;

-- ---------------------------------------------------------------------
-- context_multipliers: m = 1 + sum(k * flag). Hand-set.
-- ---------------------------------------------------------------------
INSERT INTO context_multipliers (flag, k) VALUES
  ('kids_in_car',    0.15),
  ('low_experience', 0.15)
ON CONFLICT (flag) DO UPDATE SET k = EXCLUDED.k;

-- ---------------------------------------------------------------------
-- tiers: the decision tree
-- ---------------------------------------------------------------------
INSERT INTO tiers (tier, min_score, max_score, actions) VALUES
  (0, 0,  40,     '{none}'),
  (1, 40, 70,     '{voice_nudge}'),
  (2, 70, 85,     '{voice_warning}'),
  (3, 85, 100.01, '{voice_urgent,notify_contacts}')
ON CONFLICT (tier) DO UPDATE
  SET min_score = EXCLUDED.min_score, max_score = EXCLUDED.max_score, actions = EXCLUDED.actions;

-- ---------------------------------------------------------------------
-- override_rules
-- ---------------------------------------------------------------------
INSERT INTO override_rules (rule_id, description, signal, threshold, consecutive_windows, effect, tier) VALUES
  (1, 'Microsleep: eyes closed 1.5 s or more',            'longest_eye_closure_s', 1.5, 1,  'set_tier',  3),
  (2, 'Sustained drowsiness, 30 s',                       'drowsy',                0.6, 3,  'min_tier',  2),
  (3, 'Sustained drowsiness, 2 min',                      'drowsy',                0.6, 12, 'set_tier',  3),
  (4, 'Tier 2 held for 2 min',                            'tier',                  2,   12, 'set_tier',  3),
  (5, 'Kids in car and tier 1 or higher: raise one tier', 'kids_in_car',           1,   1,  'raise_one', NULL)
ON CONFLICT (rule_id) DO UPDATE
  SET description = EXCLUDED.description, signal = EXCLUDED.signal, threshold = EXCLUDED.threshold,
      consecutive_windows = EXCLUDED.consecutive_windows, effect = EXCLUDED.effect, tier = EXCLUDED.tier;

-- ---------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------
INSERT INTO settings (key, value, note) VALUES
  ('window_seconds',              '10',    'Length of one signal window'),
  ('baseline_windows',            '6',     'First 60 s set base_hr and base_br; tier 0 during baseline'),
  ('smoothing_windows',           '3',     'Rolling mean applied before scoring'),
  ('z_cap',                       '3.912', 'ln(50). Caps stacked odds ratios'),
  ('tier_hold_windows',           '2',     'Score-based tier must hold this long before firing'),
  ('voice_cooldown_seconds',      '120',   'No repeat of same tier voice action within this time'),
  ('notify_cooldown_seconds',     '600',   'notify_contacts at most once per this time per trip'),
  ('face_lost_windows',           '3',     'After this many windows without a face, set degraded = true'),
  ('feedback_false_alarm_factor', '0.95',  'Multiply driver weight for dominant factor'),
  ('feedback_confirmed_factor',   '1.05',  'Multiply driver weight for dominant factor'),
  ('driver_weight_min',           '0.5',   'Clamp for per-driver weight multiplier'),
  ('driver_weight_max',           '1.5',   'Clamp for per-driver weight multiplier'),
  ('bandit_alpha',                '0.5',   'LinUCB exploration'),
  ('bandit_context_dim',          '8',     'bias, drowsy, agitated, speeding, trip_minutes/120, night, kids_in_car, interventions/5'),
  ('bandit_default_bias',         '0.5',   'Initial b[0] for the default action'),
  ('bandit_reward_delay_seconds', '120',   'When the reward is measured'),
  ('bandit_reward_scale',         '0.3',   'r = clamp((before - after) / scale, -1, 1)'),
  ('bandit_reward_stop_bonus',    '1',     'Driver stopped 60 s or more after a drowsy intervention'),
  ('bandit_reward_false_alarm',   '-0.5',  'Driver gave false_alarm feedback'),
  ('bandit_reward_tier_up',       '-0.5',  'Tier rose within the reward window'),
  ('night_hours',                 '{"start": 22, "end": 6}', 'Local time, end exclusive')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note;

-- ---------------------------------------------------------------------
-- bandit_actions
-- ---------------------------------------------------------------------
INSERT INTO bandit_actions (action_id, tiers, dominant, description, default_for, requires) VALUES
  ('calm_checkin',         '{1}',   'drowsy',   'You seem tired. How are you feeling?',                 '{1:drowsy}',   NULL),
  ('start_conversation',   '{1,2}', 'drowsy',   'Holds a short conversation to keep the driver alert',  '{}',           NULL),
  ('suggest_music',        '{1}',   'drowsy',   'Offers upbeat music',                                  '{}',           NULL),
  ('suggest_rest_stop',    '{1,2}', 'drowsy',   'Offers the nearest rest stop',                         '{}',           NULL),
  ('calm_slowdown',        '{1}',   'reckless', 'Calm reminder to ease off',                            '{1:reckless}', NULL),
  ('breathing_prompt',     '{1,2}', 'reckless', 'Guides two slow breaths',                              '{}',           NULL),
  ('report_card_reminder', '{1}',   'reckless', 'Tells the driver their current trip grade',            '{}',           NULL),
  ('firm_warning',         '{2}',   'both',     'Firm, direct warning',                                 '{2:drowsy,2:reckless}', NULL),
  ('family_voice_warning', '{2}',   'both',     'Warning in a family member''s recorded voice',         '{}',           'family_voice')
ON CONFLICT (action_id) DO UPDATE
  SET tiers = EXCLUDED.tiers, dominant = EXCLUDED.dominant, description = EXCLUDED.description,
      default_for = EXCLUDED.default_for, requires = EXCLUDED.requires;

-- ---------------------------------------------------------------------
-- Demo driver so the app has something to point at
-- ---------------------------------------------------------------------
INSERT INTO drivers (driver_id, display_name, sharing_mode)
VALUES ('demo', 'Demo Driver', 'high_risk_only')
ON CONFLICT (driver_id) DO NOTHING;
