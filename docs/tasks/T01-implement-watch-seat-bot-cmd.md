# New Bot cmd **Seats Watcher**

## Use Case **Dune**

### Date: Dec 14 2026

[Preview Page](https://www.cineplex.com/ticketing/preview?theatreId=9406&showtimeId=405740)
[API Availability](https://apis.cineplex.com/prod/ticketing/api/v1/theatre/9406/showtime/405740/seat-availability)
[Api Response](/Users/Ayoub/Developer/cplex-watcher/TEMP/Seat-Availability-14-Dec.json)
Sample of the response:

```JSON
{
  "seatAvailabilities": {
    "1_1_3": "Occupied",
    "1_1_4": "Occupied",
    ...
    "1_12_27": "Occupied",
    "1_12_28": "Occupied"
  },
  "isSoldOut": true,
  "isPostShowtime": false
}
```

[Seat Layout](https://apis.cineplex.com/prod/ticketing/api/v1/theatre/9406/showtime/405765/seat-layout). Sample of the response :

```JSON
{
  "totalRows": 12,
  "totalColumns": 35,
  "maxSeatSelectionAllowed": 18,
  "standardSeats": {
    "left": 0,
    "top": 0,
    "areaWidth": 35,
    "columnCount": 35,
    "columnWidth": 1,
    "rowCount": 12,
    "rows": [
      {
        "number": 0,
        "physicalNumber": 12,
        "label": "A",
        "seats": [
          {
            "id": "1_12_28",
            "column": 7,
            "columnPhysicalNumber": 28,
            "label": "A24",
            "seatGroupIds": [],
            "type": "Standard"
          },
          ...
          {
            "id": "1_12_5",
            "column": 30,
            "columnPhysicalNumber": 5,
            "label": "A1",
            "seatGroupIds": [],
            "type": "Standard"
          }
        ]
      },
      {
        "number": 1,
        "physicalNumber": 11,
        "label": "B",
        "seats": [
        {
        "id": "1_11_29",
        "column": 6,
        "columnPhysicalNumber": 29,
        "label": "B26",
        "seatGroupIds": [],
        "type": "Standard"
        },
        ...

          {
            "id": "1_1_3",
            "column": 32,
            "columnPhysicalNumber": 3,
            "label": "K1",
            "seatGroupIds": [],
            "type": "Standard"
          }
        ]
      }
    ]
  },
  "dboxSeats": {
    "left": 0,
    "top": 0,
    "areaWidth": 0,
    "columnCount": 0,
    "columnWidth": 0,
    "rowCount": 0,
    "rows": []
  },
  "balconySeats": {
    "left": 0,
    "top": 0,
    "areaWidth": 0,
    "columnCount": 0,
    "columnWidth": 0,
    "rowCount": 0,
    "rows": []
  },
  "seatLegendTypes": [
    "Standard",
    "Wheelchair",
    "Companion"
  ]
}
```

### Explanation

- theatreId is 9406 & will not change.
- showtimeId is the one that change we need to watch all those: 405740, 405741, 405743, 405745, 405750, 405751, 405752, 405753, 405754, 405755, 405760, 405761, 405765

- `"1_1_3": "Occupied"` the `1_1_3` is the id seat Format `Room_Row_nbrSeat` can be "Occupied" or "Available", not all seat ara valuable for me only those who satify this conditions: `(Row in (F, G, H, I) & 24 > columnlabel > 13) OR (Row == E & 18 > columnlabel > 8)`

## Idea to study

every 5 min make a call to the api Availability to find if there is a new Seat available.
