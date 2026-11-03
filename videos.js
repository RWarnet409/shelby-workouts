// videos.js — the "how do I do this?" lookup. One entry per exercise, keyed by the exact name shown
// in the Program tab (matching ignores case and spacing).
//
//   value = a search phrase   → the ▶ how-to link opens a YouTube search for it
//   value = a full https URL  → the link opens that exact video (paste one here once you have
//                               found a good demo; the search is just the starting point)
//   value = ''                → no link on that line (cardio warm-ups, finishers)
//
// An exercise that is not listed still gets a link: the app searches YouTube for
// "<exercise name> proper form". Add a line here only when that search gives poor results.

export const VIDEOS = {
  // cardio — no link
  'Treadmill / Elliptical / Bike': '',
  'Spin Bike or Incline Walk': '',

  // Day 1 · Back, Arms, Abs
  'Lat Pulldown Machine': 'lat pulldown machine proper form',
  'Dumbbell Hammer Curls': 'dumbbell hammer curl proper form',
  'Low Row Machine': 'seated low row machine proper form',
  'Shoulder Press (DB/machine)': 'seated dumbbell shoulder press proper form',
  'Cable Straight-Arm Pulldown': 'cable straight arm pulldown proper form',
  'Cable Tricep Pushdown': 'cable tricep pushdown proper form',
  'Plank': 'how to do a plank properly',
  'Dead Bug': 'dead bug exercise proper form',
  'Mountain Climbers': 'mountain climbers exercise proper form',

  // Day 2 · Legs & Glutes
  'BW Squats + Glute Bridges': 'bodyweight squat and glute bridge warm up form',
  'Dumbbell Goblet Squat': 'dumbbell goblet squat proper form',
  'Pause Goblet Squat (2 sec)': 'paused goblet squat how to',
  'Dumbbell Romanian Deadlift': 'dumbbell romanian deadlift proper form',
  'Dumbbell Sumo Squat': 'dumbbell sumo squat proper form',
  'Reverse Lunges': 'reverse lunge proper form',
  'Dumbbell Reverse Lunges': 'dumbbell reverse lunge proper form',
  'Leg Curl Machine': 'seated leg curl machine proper form',
  'Bicycle Crunches': 'bicycle crunches proper form',
  'Russian Twists': 'russian twist proper form',
  'Russian Twists (med ball)': 'medicine ball russian twist proper form',
  'Leg Raises': 'lying leg raises proper form',

  // Day 3 · Chest, Shoulders, Arms, Abs
  'Chest Press Machine': 'chest press machine proper form',
  'Dumbbell Lateral Raises': 'dumbbell lateral raise proper form',
  'Dumbbell One-Arm Row': 'one arm dumbbell row on bench proper form',
  'Dumbbell Biceps Curls': 'dumbbell bicep curl proper form',
  'Dumbbell Triceps Kickbacks': 'dumbbell tricep kickback proper form',
  'Bent-Over Rear Delt Fly': 'bent over dumbbell rear delt fly proper form',
  'Ab Machine': 'ab crunch machine proper form',
  'Side Plank (each side)': 'side plank proper form beginner',
  'Plank Shoulder Taps': 'plank shoulder taps proper form',

  // Day 4 · Legs, Glutes, Abs (circuits)
  'Dumbbell Sumo Deadlift': 'dumbbell sumo deadlift proper form',
  'Bird Dog': 'bird dog exercise proper form',
  'Walking or Reverse Lunges': 'walking lunge proper form',
  'Walking/Reverse Lunges (DB)': 'dumbbell walking lunge proper form',
  'Tuck Crunches': 'tuck crunch exercise how to',
  'Floor Glute Bridge': 'glute bridge proper form',
  'Glute Bridge (DB on hips)': 'dumbbell glute bridge proper form',
  'Single-Leg Glute Bridge': 'single leg glute bridge proper form',
  'Side-Lying Leg Raises': 'side lying leg raise proper form',
  'Bodyweight Squats': 'bodyweight squat proper form',
  'Goblet Squats': 'dumbbell goblet squat proper form',
  'Reverse Crunches': 'reverse crunch proper form',
};
