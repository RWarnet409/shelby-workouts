// starting.js — the day-one weight hints. Until an exercise has a logged weight, its weight box shows
// this value faintly (a placeholder); once there is history, last time's number takes over.
//
// One entry per exercise, keyed by the exact name shown in the Program tab (matching ignores case and
// spacing). The value is text, shown as-is inside the box:
//   '15–20'  → a dumbbell range in lb (from the Starting weights table in docs/PROGRAM.md)
//   '5'      → a single weight
//   'pin'    → a machine or cable stack: note the pin number that makes 12 reps hard but doable
// An exercise that is not listed shows an empty box. Edit here, bump the version markers, redeploy.

export const START_WEIGHTS = {
  // Legs & glutes
  'Dumbbell Goblet Squat': '15–20',
  'Pause Goblet Squat (2 sec)': '15–20',
  'Goblet Squats': '15–20',
  'Dumbbell Romanian Deadlift': '15–20',
  'Dumbbell Sumo Squat': '20–30',
  'Dumbbell Sumo Deadlift': '20–30',
  'Dumbbell Reverse Lunges': '8–10',
  'Walking/Reverse Lunges (DB)': '8–10',
  'Glute Bridge (DB on hips)': '20–25',

  // Upper body dumbbells
  'Shoulder Press (DB/machine)': '8–10',
  'Dumbbell Lateral Raises': '5',
  'Bent-Over Rear Delt Fly': '5',
  'Dumbbell Hammer Curls': '8–10',
  'Dumbbell Biceps Curls': '8–10',
  'Dumbbell One-Arm Row': '12–15',
  'Dumbbell Triceps Kickbacks': '5–8',

  // Abs
  'Russian Twists (med ball)': '6–8',

  // Machines and cables: the stack, not a dumbbell
  'Lat Pulldown Machine': 'pin',
  'Low Row Machine': 'pin',
  'Chest Press Machine': 'pin',
  'Leg Curl Machine': 'pin',
  'Ab Machine': 'pin',
  'Cable Straight-Arm Pulldown': 'pin',
  'Cable Tricep Pushdown': 'pin',

  // Swap-library exercises in the same family as one above
  'Close-Grip Lat Pulldown': 'pin',
  'Underhand Lat Pulldown': 'pin',
  'Cable Rope Pushdown': 'pin',
  'Cable Biceps Curls': 'pin',
  'Cable Lateral Raises': 'pin',
  'Cable Face Pull': 'pin',
  'Cable Crunch': 'pin',
  'Pallof Press': 'pin',
  'Chest-Supported Dumbbell Row': '12–15',
  'Dumbbell Bent-Over Row': '12–15',
  'Incline Dumbbell Curls': '8–10',
  'Alternating Dumbbell Curls': '8–10',
  'Dumbbell Front Raises': '5',
  'Dumbbell Deadlift': '15–20',
  'Dumbbell Squat to Bench': '15–20',
  'Dumbbell Step-Ups': '8–10',
  'Dumbbell Hip Thrust': '20–25',
};
