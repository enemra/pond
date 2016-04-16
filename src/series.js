/**
 *  Copyright (c) 2015, The Regents of the University of California,
 *  through Lawrence Berkeley National Laboratory (subject to receipt
 *  of any required approvals from the U.S. Dept. of Energy).
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree.
 */

import _ from "underscore";
import Immutable from "immutable";

import Collection from "./collection";
import Index from "./index";
import { Event, TimeRangeEvent, IndexedEvent } from "./event";
import { Pipeline } from "./pipeline.js";

function buildMetaData(meta) {
    let d = meta ? meta : {};

    // Name
    d.name = meta.name ? meta.name : "";
    
    // Index
    if (meta.index) {
        if (_.isString(meta.index)) {
            d.index = new Index(meta.index);
        } else if (meta.index instanceof(Index)) {
            d.index = meta.index;
        }
    }

    // UTC or Local time
    d.utc = true;
    if (_.isBoolean(meta.utc)) {
        d.utc = meta.utc;
    }

    return new Immutable.Map(d);
}

/**
 * A TimeSeries is a a Series where each event is an association of a timestamp
 * and some associated data.
 *
 * Data passed into it may have the following format, which is our wire format:
 *
 *   {
 *     "name": "traffic",
 *     "columns": ["time", "value", ...],
 *     "points": [
 *        [1400425947000, 52, ...],
 *        [1400425948000, 18, ...],
 *        [1400425949000, 26, ...],
 *        [1400425950000, 93, ...],
 *        ...
 *      ]
 *   }
 *
 * Alternatively, the TimeSeries may be constructed from a list of Event objects.
 *
 * Internaly the above series is represented as two parts:
 *  * Collection - an Immutable.List of Events and associated methods
 *                   to query and manipulate that list
 *  * Meta data  - an Immutable.Map of extra data associated with the
 *                   TimeSeries
 *
 * The events stored in the collection may be Events (timestamp based),
 * TimeRangeEvents (time range based) or IndexedEvents (an alternative form
 * of a time range, such as "2014-08" or "1d-1234")
 *
 * The timerange associated with a TimeSeries is simply the bounds of the
 * events within it (i.e. the min and max times).
 */
class TimeSeries {

    constructor(arg) {
        this._collection = null;  // Collection
        this._data = null;        // Meta data

        if (arg instanceof TimeSeries) {

            //
            // Copy another TimeSeries
            //

            const other = arg;
            this._data = other._data;
            this._collection = other._collection;
        } else if (_.isObject(arg)) {

            //
            // TimeSeries(object data) where data may be:
            //    { "events": [event-1, event-2, ..., event-n]}
            // or
            //    { "columns": [time|timerange|index, column-1, ..., column-n]
            //      "points": [
            //         [t1, v1, v2, ..., v2],
            //         [t2, v1, v2, ..., vn],
            //         ...
            //      ]
            //    }

            const obj = arg;

            if (_.has(obj, "events")) {

                //
                // Initialized from an event list
                //

                const { events, ...meta1 } = obj; //eslint-disable-line

                this._collection = new Collection(events);
                this._data = buildMetaData(meta1);

            } else if (_.has(obj, "collection")) {
                const { collection, ...meta3 } = obj; //eslint-disable-line
                this._collection = collection;
                this._data = buildMetaData(meta3);
            } else if (_.has(obj, "columns") && _.has(obj, "points")) {

                //
                // Initialized from the wire format
                //

                const { columns, points, ...meta2 } = obj; //eslint-disable-line
                const [eventType, ...eventFields] = columns;
                const events = points.map(point => {
                    const [t, ...eventValues] = point;
                    const d = _.object(eventFields, eventValues);
                    switch (eventType) {
                        case "time":
                            return new Event(t, d);
                        case "timerange":
                            return new TimeRangeEvent(t, d);
                        case "index":
                            return new IndexedEvent(t, d);
                        default:
                            throw new Error(`Unknown event type: ${eventType}`);
                    }
                });

                this._collection = new Collection(events);
                this._data = buildMetaData(meta2);
            }
        }
    }

    //
    // Serialize
    //

    /**
     * Turn the TimeSeries into regular javascript objects
     */
    toJSON() {
        let columns;
        const type = this._collection.type();
        if (type === Event) {
            columns = ["time", ...this.columns()];
        } else if (type === TimeRangeEvent) {
            columns = ["timerange", ...this.columns()];
        } else if (type === IndexedEvent) {
            columns = ["index", ...this.columns()];
        }

        const points = [];
        for (const e of this._collection.events()) {
            points.push(e.toPoint());
        }

        return _.extend(this._data.toJSON(), {
            columns,
            points
        });
    }

    /**
     * Represent the TimeSeries as a string
     */
    toString() {
        return JSON.stringify(this.toJSON());
    }

    /**
     * Returns the extents of the TimeSeries as a TimeRange.
     */
    timerange() {
        return this._collection.range();
    }

    range() {
        return this.timerange();
    }

    /**
     * Gets the earliest time represented in the TimeSeries.
     * @return {Date} Begin time
     */
    begin() {
        return this.range().begin();
    }

    /**
     * Gets the latest time represented in the TimeSeries.
     * @return {Date} End time
     */
    end() {
        return this.range().end();
    }

    /**
     * Access the series events via index
     */
    at(i) {
        return this._collection.at(i);
    }

    /**
     * Finds the index that is just less than the time t supplied.
     * In other words every event at the returned index or less
     * has a time before the supplied t, and every sample after the
     * index has a time later than the supplied t.
     *
     * Optionally supply a begin index to start searching from.
     */
    bisect(t, b) {
        return this._collection.bisect(t, b);
    }

    /**
     * Perform a slice of events within the TimeSeries, returns a new
     * TimeSeries representing a portion of this TimeSeries from begin up to
     * but not including end.
     */
    slice(begin, end) {
        const sliced = this._collection.slice(begin, end);
        const result = new TimeSeries(this);
        result._collection = sliced;
        return result;
    }

    clean(fieldSpec) {
        const cleaned = this._collection.clean(fieldSpec);
        const result = new TimeSeries(this);
        result._collection = cleaned;
        return result;
    }

    /**
     *  Generator to allow for..of loops over series.events()
     */
    * events() {
        for (let i = 0; i < this.size(); i++) {
            yield this.at(i);
        }
    }


    //
    // Access meta data about the series
    //

    name() {
        return this._data.get("name");
    }

    /**
     * Access the Index, if this TimeSeries has one
     */

    index() {
        return this._data.get("index");
    }

    indexAsString() {
        return this.index() ? this.index().asString() : undefined;
    }

    indexAsRange() {
        return this.index() ? this.index().asTimerange() : undefined;
    }

    isUTC() {
        return this._data.get("utc");
    }

    columns() {
        const c = {};
        for (const e of this._collection.events()) {
            const d = e.toJSON().data;
            _.each(d, (val, key) => {c[key] = true;});
        }
        return _.keys(c);
    }

    /**
     * Returns the internal collection of events for this TimeSeries
     */
    collection() {
        return this._collection;
    }

    /**
     * Returns the meta data about this TimeSeries as a JSON object
     */
    meta(key) {
        if (!key) {
            return this._data.toJSON();
        } else {
            return this._data.get(key);
        }
    }

    //
    // Access the series itself
    //

    /**
     * Returns the number of rows in the series.
     */
    size() {
        return this._collection.size();
    }

    /**
     * Returns the number of rows in the series.
     */
    sizeValid(fieldSpec) {
        return this._collection.sizeValid(fieldSpec);
    }

    /**
     * Returns the number of rows in the series. (Same as size())
     * @return {number} Size of the series
     */
    count() {
        return this.size();
    }

    sum(fieldSpec) {
        return this._collection.sum(fieldSpec);
    }

    max(fieldSpec) {
        return this._collection.max(fieldSpec);
    }

    min(fieldSpec) {
        return this._collection.min(fieldSpec);
    }

    avg(fieldSpec) {
        return this._collection.avg(fieldSpec);
    }

    mean(fieldSpec) {
        return this._collection.mean(fieldSpec);
    }

    median(fieldSpec) {
        return this._collection.median(fieldSpec);
    }

    stdev(fieldSpec) {
        return this._collection.stdev(fieldSpec);
    }

    aggregate(func, fieldSpec) {
        return this._collection.aggregate(func, fieldSpec);
    }

    pipeline() {
        return new Pipeline()
            .from(this._collection);
    }

    /**
     * STATIC
     */

    static equal(series1, series2) {
        return (series1._name === series2._name &&
                series1._meta === series2._meta &&
                series1._utc === series2._utc &&
                series1._columns === series2._columns &&
                series1._data === series2._data &&
                series1._times === series2._times);
    }

    static is(series1, series2) {
        return (series1._name === series2._name &&
                series1._utc === series2._utc &&
                Immutable.is(series1._meta, series2._meta) &&
                Immutable.is(series1._columns, series2._columns) &&
                Immutable.is(series1._data, series2._data) &&
                Immutable.is(series1._times, series2._times));
    }

    static map(data, seriesList, mapper) {
        // for each series, map events to the same timestamp/index
        const eventMap = {};
        _.each(seriesList, (series) => {
            for (const event of series.events()) {
                let key;
                if (event instanceof Event) {
                    key = event.timestamp();
                } else if (event instanceof IndexedEvent) {
                    key = event.index();
                } else if (event instanceof TimeRangeEvent) {
                    key = event.timerange().toUTCString();
                }

                if (!_.has(eventMap, key)) {
                    eventMap[key] = [];
                }

                eventMap[key].push(event);
            }
        });

        // for each key, merge the events associated with that key
        const events = [];
        _.each(eventMap, (eventsList) => {
            const event = mapper(eventsList);
            events.push(event);
        });

        return new TimeSeries({...data, events});
    }

    static merge(data, seriesList) {
        return TimeSeries.map(data, seriesList, Event.merge);
    }
}

export default TimeSeries;

