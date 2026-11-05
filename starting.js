// starting.js — the day-one weight hints. Until an exercise has a logged weight, its weight box shows
// this value faintly (a placeholder); once there is history, last time's number takes over.
//
// One entry per exercise, keyed by the exact name shown in the Program tab (matching ignores case and
// spacing). The value is text, shown as-is inside the box:
//   '15–20'  → a dumbbell range in lb (from the Starting weights table in docs/PROGRAM.md)
//   '5'      → a single weight
//   'pin'    → a machine or cable stack: note the pin number that makes 12 reps hard but doable
//   'bar'    → the Smith machine: start with the empty bar, log the plates added per side
// The dumbbell rack at the Avalon gym goes 5, 10, 15 … 50 lb in 5-lb steps (no 8s or 12s), so the
// hints only name weights that exist. An exercise that is not listed shows an empty box.
// Edit here, bump the version markers, redeploy.

export const START_WEIGHTS = {
  // Legs & glutes
  'Dumbbell Goblet Squat': '15–20',
  'Pause Goblet Squat (2 sec)': '15–20',
  'Goblet Squats': '15–20',
  'Dumbbell Romanian Deadlift': '15–20',
  'Dumbbell Sumo Squat': '20–30',
  'Dumbbell Sumo Deadlift': '20–30',
  'Dumbbell Reverse Lunges': '10',
  'Walking/Reverse Lunges (DB)': '10',
  'Glute Bridge (DB on hips)': '20–25',

  // Upper body dumbbells
  'Shoulder Press (DB/machine)': '5–10',
  'Dumbbell Lateral Raises': '5',
  'Bent-Over Rear Delt Fly': '5',
  'Dumbbell Hammer Curls': '10',
  'Dumbbell Biceps Curls': '10',
  'Dumbbell One-Arm Row': '15',
  'Dumbbell Triceps Kickbacks': '5',

  // Abs
  'Russian Twists (med ball)': '6–8',

  // Machines and cables: the stack, not a dumbbell
  'Lat Pulldown Machine': 'pin',
  'Low Row Machine': 'pin',
  'Chest Press Machine': 'pin',
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
  'Single-Arm Cable Row': 'pin',
  'Cable Chest Fly': 'pin',
  'Cable Overhead Triceps Extension': 'pin',
  'Cable Pull-Through': 'pin',
  'Cable Glute Kickback': 'pin',
  'Cable Woodchop': 'pin',
  'Chest-Supported Dumbbell Row': '15',
  'Dumbbell Bent-Over Row': '15',
  'Incline Dumbbell Curls': '10',
  'Alternating Dumbbell Curls': '10',
  'Dumbbell Front Raises': '5',
  'Dumbbell Deadlift': '15–20',
  'Dumbbell Squat to Bench': '15–20',
  'Dumbbell Step-Ups': '10',
  'Dumbbell Hip Thrust': '20–25',
  'Dumbbell Bench Press': '10–15',
  'Incline Dumbbell Press': '10–15',
  'Dumbbell Chest Fly': '10',
  'Dumbbell Pullover': '15',
  'Overhead Dumbbell Triceps Extension': '10',
  'Dumbbell Side Bend': '15',

  // Kettlebells (by the studio mirror), medicine balls (studio rack), the Smith machine
  'Kettlebell Swing': '15–20',
  'Kettlebell Goblet Squat': '15–20',
  'Kettlebell Deadlift': '20',
  'Medicine Ball Slams': '8–10',
  'Smith Machine Squat': 'bar',
  'Smith Machine Bench Press': 'bar',
  'Smith Machine Romanian Deadlift': 'bar',
  'Smith Machine Hip Thrust': 'bar',
};
